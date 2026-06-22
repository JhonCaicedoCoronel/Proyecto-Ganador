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

let contadorTurnos = 1; 
const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];

async function iniciarServidor() {
    const { data: maxTurno } = await supabase.from('pedidos_cocina').select('turno_fila').order('turno_fila', { ascending: false }).limit(1);
    if (maxTurno && maxTurno.length > 0) contadorTurnos = maxTurno[0].turno_fila + 1;
}
iniciarServidor();

async function emitirMenuActualizado() {
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    io.emit('menu-actualizado-completo', menuProductos || []);
}
async function emitirMesasActualizadas() {
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    io.emit('mesas-actualizadas', estadoMesas || []);
}

io.on('connection', async (socket) => {
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    
    socket.emit('cargar-menu-inicial', menuProductos || []);
    socket.emit('cargar-mesas-inicial', estadoMesas || []);

    // --- NUEVO: KDS EXIGE LOS PEDIDOS PENDIENTES AL CONECTARSE ---
    socket.on('obtener-pedidos-cocina', async () => {
        const { data: pedidosDB, error } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'pendiente').order('id', { ascending: true });
        if (error) console.error("Error en Supabase:", error);
        
        const pedidosPendientes = (pedidosDB || []).map(p => ({
            id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
            turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
            horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
        }));
        socket.emit('cargar-pedidos-cocina', pedidosPendientes);
    });

    // --- NUEVO: ENDPOINT PARA EL HISTORIAL DE VENTAS ---
    socket.on('obtener-historial-dia', async () => {
        // Traemos los últimos 100 pedidos que ya fueron marcados como 'entregado'
        const { data: historialDB } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'entregado').order('id', { ascending: false }).limit(100);
        socket.emit('cargar-historial', historialDB || []);
    });

    socket.on('consultar-horarios', async (datos) => {
        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha);
        const { data: mesasDB } = await supabase.from('mesas').select('*');
        const reservasGlobales = reservasDB || []; const mesasTotales = mesasDB || [];

        const horariosEstado = horariosDisponibles.map(hora => {
            const reservasTurno = reservasGlobales.filter(r => r.hora === hora);
            const mesasOcupadasIds = reservasTurno.map(r => r.mesa_id);
            const mesasLibres = mesasTotales.filter(m => !mesasOcupadasIds.includes(m.numero));
            const mesasAptas = mesasLibres.filter(m => m.capacidad >= personasRequeridas);
            return { hora: hora, lleno: mesasAptas.length === 0, disponibles: mesasAptas.length };
        });
        socket.emit('horarios-para-fecha', horariosEstado);
    });

    socket.on('verificar-disponibilidad', async (datos) => {
        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha);
        const { data: mesasDB } = await supabase.from('mesas').select('*');
        const reservasGlobales = reservasDB || []; const mesasTotales = mesasDB || [];

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

    socket.on('enviar-reserva-pedido', async (pedido) => {
        pedido.turnoFila = contadorTurnos++;
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        
        await supabase.from('reservas').insert([{ id: pedido.id, cliente: pedido.cliente, fecha: pedido.datosReserva.fecha, hora: pedido.datosReserva.hora, personas: pedido.datosReserva.personas, mesa_id: pedido.datosReserva.mesa.numero }]);

        pedido.esFantasma = true; 
        pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
        pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Reserva Pagada Web ✅" : "Reserva Pendiente Pago 💵";

        // Guardar el pedido en Supabase de forma segura
        const { error } = await supabase.from('pedidos_cocina').insert([{
            id: pedido.id, cliente: pedido.cliente, item: pedido.item, pago: pedido.pago, tipo: "Reserva en Local",
            turno_fila: pedido.turnoFila, es_fantasma: pedido.esFantasma, hora_registro: pedido.horaRegistro,
            hora_llegada_estimada: pedido.horaLlegadaEstimada, estado_cocina_texto: pedido.estadoCocinaTexto, datos_reserva: pedido.datosReserva
        }]);
        if(error) console.log("Error al guardar pedido en DB:", error);

        if (pedido.productosComprados && pedido.productosComprados.length > 0) {
            for (const item of pedido.productosComprados) {
                const { data: productoDB } = await supabase.from('menu').select('stock').eq('id', item.id).single();
                if (productoDB) {
                    await supabase.from('menu').update({ stock: Math.max(0, productoDB.stock - item.cantidad) }).eq('id', item.id);
                }
            }
            await emitirMenuActualizado();
        }

        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        io.emit('notificar-cocina', pedido);
        io.emit('reserva-confirmada-actualizar', pedido.datosReserva.fecha);
    });

    socket.on('guardar-encuesta-opcional', async (datos) => { await supabase.from('clientes_perfil').insert([{ cliente: datos.cliente, alergias: datos.alergias, preferencias: datos.preferencias }]); });

    socket.on('pedido-despachado-cocina', async (id) => { 
        await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', id);
        io.emit('pedido-listo-retirar', id); 
    });
    
    socket.on('cambiar-estado-mesa', async (datos) => { await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero); await emitirMesasActualizadas(); });
    socket.on('agregar-nuevo-producto', async (p) => { await supabase.from('menu').insert([{ nombre: p.nombre, precio: p.precio, stock: p.stock, category: p.category, img: p.img }]); await emitirMenuActualizado(); });
    socket.on('editar-producto', async (p) => { await supabase.from('menu').update({ nombre: p.nombre, precio: p.precio, stock: p.stock, category: p.category, img: p.img }).eq('id', p.id); await emitirMenuActualizado(); });
    socket.on('eliminar-producto', async (id) => { await supabase.from('menu').delete().eq('id', id); await emitirMenuActualizado(); });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Motor conectado a Supabase en el puerto ${PORT}`));