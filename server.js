require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static('public'));
app.get('/', (req, res) => { res.redirect('/quiosco.html'); });

const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];

async function emitirMenuActualizado() {
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    io.emit('menu-actualizado-completo', menuProductos || []);
}
async function emitirMesasActualizadas() {
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    io.emit('mesas-actualizadas', estadoMesas || []);
}

io.on('connection', async (socket) => {
    
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    
    socket.emit('cargar-menu-inicial', menuProductos || []);
    socket.emit('cargar-mesas-inicial', estadoMesas || []);

    socket.on('obtener-historial-reservas', async () => {
        const { data: reservasDB } = await supabase.from('reservas').select('*').order('fecha', { ascending: false }).order('hora', { ascending: false });
        socket.emit('cargar-historial-reservas', reservasDB || []);
    });

    socket.on('marcar-salida-reserva', async (datos) => {
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        const horaActual = new Date().toLocaleTimeString('en-US', opciones);

        const { data: resSale } = await supabase.from('reservas').select('*').eq('id', datos.id).single();

        if (resSale) {
            await supabase.from('reservas').update({ estado: 'finalizada', hora_salida: horaActual }).eq('id', datos.id);
            await supabase.from('mesas').update({ estado: 'sucia' }).eq('numero', datos.mesa_id);

            const { data: reservasAfectadas } = await supabase
                .from('reservas').select('*')
                .eq('sucursal', resSale.sucursal).eq('fecha', resSale.fecha).eq('hora', resSale.hora)
                .eq('estado', 'activa').gt('turno_sala', resSale.turno_sala);

            if (reservasAfectadas && reservasAfectadas.length > 0) {
                for (const r of reservasAfectadas) {
                    const nuevoTurno = r.turno_sala - 1;
                    await supabase.from('reservas').update({ turno_sala: nuevoTurno }).eq('id', r.id);
                    io.emit('notificacion-avance-turno', { idReserva: r.id, nuevoTurno: nuevoTurno });
                }
            }
        }

        await emitirMesasActualizadas();
        const { data: reservasDB } = await supabase.from('reservas').select('*').order('fecha', { ascending: false }).order('hora', { ascending: false });
        io.emit('cargar-historial-reservas', reservasDB || []);
    });

    socket.on('consultar-horarios', async (datos) => {
        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
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
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
        const { data: mesasDB } = await supabase.from('mesas').select('*');
        const reservasGlobales = reservasDB || []; const mesasTotales = mesasDB || [];

        const reservasTurno = reservasGlobales.filter(r => r.hora === datos.hora);
        const mesasOcupadasIds = reservasTurno.map(r => r.mesa_id);
        const mesasLibres = mesasTotales.filter(m => !mesasOcupadasIds.includes(m.numero));
        const mesasAptas = mesasLibres.filter(m => m.capacidad >= personasRequeridas);

        if (mesasAptas.length > 0) {
            mesasAptas.sort((a, b) => a.capacidad - b.capacidad);
            socket.emit('resultado-disponibilidad', { disponible: true, horaExacta: datos.hora, mesa: mesasAptas[0], sucursal: datos.sucursal });
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
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        
        const { data: reservasMismoTurno } = await supabase
            .from('reservas').select('id')
            .eq('sucursal', pedido.datosReserva.sucursal).eq('fecha', pedido.datosReserva.fecha).eq('hora', pedido.datosReserva.hora).eq('estado', 'activa');

        let turnoAsignado = (reservasMismoTurno ? reservasMismoTurno.length : 0) + 1;
        pedido.turnoFila = turnoAsignado; 

        await supabase.from('reservas').insert([{ 
            id: pedido.id, cliente: pedido.cliente, fecha: pedido.datosReserva.fecha, 
            hora: pedido.datosReserva.hora, personas: pedido.datosReserva.personas, 
            mesa_id: pedido.datosReserva.mesa.numero, estado: 'activa', sucursal: pedido.datosReserva.sucursal,
            turno_sala: turnoAsignado
        }]);

        pedido.esFantasma = true; 
        pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
        pedido.estadoCocinaTexto = (pedido.pago === 'Solo Reserva') ? "Reservó Mesa (Pedirá en Local) 🪑" : ((pedido.pago === 'Tarjeta') ? "Pre-orden Pagada Web ✅" : "Pre-orden Pendiente 💵");

        await supabase.from('pedidos_cocina').insert([{
            id: pedido.id, cliente: pedido.cliente, item: pedido.item, pago: pedido.pago, tipo: "Reserva en Local",
            turno_fila: pedido.turnoFila, es_fantasma: pedido.esFantasma, hora_registro: pedido.horaRegistro,
            hora_llegada_estimada: pedido.horaLlegadaEstimada, estado_cocina_texto: pedido.estadoCocinaTexto, datos_reserva: pedido.datosReserva
        }]);

        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        io.emit('notificar-cocina', pedido);
        io.emit('reserva-confirmada-actualizar', pedido.datosReserva.fecha);
    });

    socket.on('obtener-pedidos-cocina', async () => {
        const { data: pedidosDB } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'pendiente').order('id', { ascending: true });
        const pedidosPendientes = (pedidosDB || []).map(p => ({
            id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
            turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
            horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
        }));
        socket.emit('cargar-pedidos-cocina', pedidosPendientes);
    });

    socket.on('obtener-historial-dia', async () => {
        const { data: historialDB } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'entregado').order('id', { ascending: false }).limit(100);
        socket.emit('cargar-historial', historialDB || []);
    });

    socket.on('guardar-encuesta-opcional', async (datos) => { await supabase.from('clientes_perfil').insert([{ cliente: datos.cliente, alergias: datos.alergias, preferencias: datos.preferencias }]); });
    socket.on('pedido-despachado-cocina', async (id) => { await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', id); io.emit('pedido-listo-retirar', id); });
    socket.on('cambiar-estado-mesa', async (datos) => { await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero); await emitirMesasActualizadas(); });
    
    socket.on('agregar-nuevo-producto', async (p) => { 
        await supabase.from('menu').insert([{ nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal }]); 
        await emitirMenuActualizado(); 
    });
    
    socket.on('editar-producto', async (p) => { 
        await supabase.from('menu').update({ nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal }).eq('id', p.id); 
        await emitirMenuActualizado(); 
    });    
    
    socket.on('eliminar-producto', async (id) => { await supabase.from('menu').delete().eq('id', id); await emitirMenuActualizado(); });
});

// --- SISTEMA DE ALERTAS PRE-RESERVA (Se ejecuta cada minuto) ---
setInterval(async () => {
    // 1. Obtener fecha y hora actuales en Ecuador
    const opcionesHora = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false };
    const ahoraEcuador = new Date().toLocaleTimeString('en-US', opcionesHora); // Formato "HH:MM" (24 hrs)
    
    // Obtener la fecha en formato YYYY-MM-DD
    const fechaEcuadorFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());

    // 2. Extraer horas y minutos para los cálculos
    let [horaActual, minActual] = ahoraEcuador.split(':').map(Number);
    let totalMinutosActuales = (horaActual * 60) + minActual;

    // 3. Consultar las reservas "activas" de hoy
    const { data: reservasHoy } = await supabase
        .from('reservas')
        .select('*')
        .eq('fecha', fechaEcuadorFormat)
        .eq('estado', 'activa');

    if (reservasHoy && reservasHoy.length > 0) {
        reservasHoy.forEach(reserva => {
            // Convertir la hora de la reserva a formato 24h para facilitar el cálculo
            // (Asumiendo que guardaste horas en formato "12:00", "13:00", etc. según tus horarios disponibles)
            let [horaReserva, minReserva] = reserva.hora.split(':').map(Number);
            let totalMinutosReserva = (horaReserva * 60) + minReserva;

            // 4. Calcular la diferencia en minutos
            let diferenciaMinutos = totalMinutosReserva - totalMinutosActuales;

            // 5. Si faltan exactamente 15 minutos (o entre 10 y 15 para dar margen), disparamos la alerta
            if (diferenciaMinutos === 15 || diferenciaMinutos === 14) {
                // Emitimos un evento global, pero el cliente filtrará por su ID
                io.emit('alerta-proxima-reserva', {
                    idReserva: reserva.id,
                    sucursal: reserva.sucursal,
                    minutosRestantes: diferenciaMinutos
                });
                
                console.log(`🔔 Alerta enviada para la reserva #${reserva.id} (Faltan ${diferenciaMinutos} min)`);
            }
        });
    }
}, 60000); // 60000 milisegundos = 1 minuto
// -------------------------------------------------------------

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor Costeñito corriendo en puerto ${PORT}`));