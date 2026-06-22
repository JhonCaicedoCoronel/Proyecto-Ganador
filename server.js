require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const { createClient } = require('@supabase/supabase-js');

// --- CONEXIÓN A SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static('public'));
app.get('/', (req, res) => { res.redirect('/quiosco.html'); });

let contadorTurnos = 1; // El turno de la fila física se reinicia cada día
const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];

// Función auxiliar para emitir menú actualizado
async function emitirMenuActualizado() {
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    io.emit('menu-actualizado-completo', menuProductos || []);
}

// Función auxiliar para emitir mesas actualizadas
async function emitirMesasActualizadas() {
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    io.emit('mesas-actualizadas', estadoMesas || []);
}

io.on('connection', async (socket) => {
    // 1. Cargar datos iniciales desde la nube al conectar
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    
    socket.emit('cargar-menu-inicial', menuProductos || []);
    socket.emit('cargar-mesas-inicial', estadoMesas || []);

    // --- ALGORITMO INTELIGENTE: CONSULTAR HORARIOS ---
    socket.on('consultar-horarios', async (datos) => {
        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha);
        const { data: mesasDB } = await supabase.from('mesas').select('*');
        
        const reservasGlobales = reservasDB || [];
        const mesasTotales = mesasDB || [];

        const horariosEstado = horariosDisponibles.map(hora => {
            const reservasTurno = reservasGlobales.filter(r => r.hora === hora);
            const mesasOcupadasIds = reservasTurno.map(r => r.mesa_id);
            const mesasLibres = mesasTotales.filter(m => !mesasOcupadasIds.includes(m.numero));
            const mesasAptas = mesasLibres.filter(m => m.capacidad >= personasRequeridas);

            return { hora: hora, lleno: mesasAptas.length === 0, disponibles: mesasAptas.length };
        });
        socket.emit('horarios-para-fecha', horariosEstado);
    });

    // --- VALIDACIÓN DE RESERVA Y ASIGNACIÓN ---
    socket.on('verificar-disponibilidad', async (datos) => {
        const personasRequeridas = parseInt(datos.personas) || 1;
        
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha);
        const { data: mesasDB } = await supabase.from('mesas').select('*');
        
        const reservasGlobales = reservasDB || [];
        const mesasTotales = mesasDB || [];

        const reservasTurno = reservasGlobales.filter(r => r.hora === datos.hora);
        const mesasOcupadasIds = reservasTurno.map(r => r.mesa_id);
        const mesasLibres = mesasTotales.filter(m => !mesasOcupadasIds.includes(m.numero));
        const mesasAptas = mesasLibres.filter(m => m.capacidad >= personasRequeridas);

        if (mesasAptas.length > 0) {
            mesasAptas.sort((a, b) => a.capacidad - b.capacidad);
            socket.emit('resultado-disponibilidad', { disponible: true, horaExacta: datos.hora, mesa: mesasAptas[0] });
        } else {
            let alternativas = horariosDisponibles.filter(h => {
                const resTurnoAlt = reservasGlobales.filter(r => r.hora === h);
                const ocupIdsAlt = resTurnoAlt.map(r => r.mesa_id);
                const libresAlt = mesasTotales.filter(m => !ocupIdsAlt.includes(m.numero));
                return libresAlt.some(m => m.capacidad >= personasRequeridas);
            });
            socket.emit('resultado-disponibilidad', { disponible: false, alternativas: alternativas.slice(0, 3) });
        }
    });

    // --- PROCESAMIENTO DE LA ORDEN ---
    socket.on('enviar-reserva-pedido', async (pedido) => {
        pedido.turnoFila = contadorTurnos++;
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        
        // Guardar reserva en Supabase
        await supabase.from('reservas').insert([{
            id: pedido.id,
            cliente: pedido.cliente,
            fecha: pedido.datosReserva.fecha,
            hora: pedido.datosReserva.hora,
            personas: pedido.datosReserva.personas,
            mesa_id: pedido.datosReserva.mesa.numero
        }]);

        // Configurar pre-orden
        pedido.esFantasma = true; 
        pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
        pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Reserva Pagada Web ✅" : "Reserva Pendiente Pago 💵";

        // Descontar inventario en Supabase
        if (pedido.productosComprados && pedido.productosComprados.length > 0) {
            for (const item of pedido.productosComprados) {
                const { data: productoDB } = await supabase.from('menu').select('stock').eq('id', item.id).single();
                if (productoDB) {
                    const nuevoStock = Math.max(0, productoDB.stock - item.cantidad);
                    await supabase.from('menu').update({ stock: nuevoStock }).eq('id', item.id);
                }
            }
            await emitirMenuActualizado();
        }

        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        io.emit('notificar-cocina', pedido);
        io.emit('reserva-confirmada-actualizar', pedido.datosReserva.fecha);
    });

    // Guardar Encuestas Opcionales permanentemente
    socket.on('guardar-encuesta-opcional', async (datosEncuesta) => {
        await supabase.from('clientes_perfil').insert([{
            cliente: datosEncuesta.cliente,
            alergias: datosEncuesta.alergias,
            preferencias: datosEncuesta.preferencias
        }]);
    });

    socket.on('pedido-despachado-cocina', (id) => { io.emit('pedido-listo-retirar', id); });
    
    socket.on('cambiar-estado-mesa', async (datos) => {
        await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero);
        await emitirMesasActualizadas();
    });

    // --- CRUD MENÚ ADMIN ---
    socket.on('agregar-nuevo-producto', async (p) => { 
        await supabase.from('menu').insert([{
            nombre: p.nombre, precio: p.precio, stock: p.stock, category: p.category, img: p.img
        }]);
        await emitirMenuActualizado();
    });
    
    socket.on('editar-producto', async (p) => {
        await supabase.from('menu').update({
            nombre: p.nombre, precio: p.precio, stock: p.stock, category: p.category, img: p.img
        }).eq('id', p.id);
        await emitirMenuActualizado();
    });
    
    socket.on('eliminar-producto', async (id) => { 
        await supabase.from('menu').delete().eq('id', id);
        await emitirMenuActualizado();
    });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Motor conectado a Supabase en el puerto ${PORT}`));