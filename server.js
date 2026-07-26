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

async function emitirMenuActualizado(tenantId) {
    const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
    io.to(tenantId).emit('menu-actualizado-completo', menuProductos || []);
}
async function emitirMesasActualizadas(tenantId) {
    const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
    io.to(tenantId).emit('mesas-actualizadas', estadoMesas || []);
}

io.on('connection', async (socket) => {
    
    // Capturamos el evento de unión a la sala de la franquicia correspondiente
    socket.on('unirse-a-restaurante', async (tenantId) => {
        socket.join(tenantId);
        socket.tenantId = tenantId; // Guardamos el tenant en la sesión del socket

        const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
        const { data: menuProductos } = await supabase.from('menu').select('*').order('id', { ascending: true });
        
        socket.emit('cargar-menu-inicial', menuProductos || []);
        socket.emit('cargar-mesas-inicial', estadoMesas || []);
    });

    socket.on('obtener-historial-reservas', async (tenantId) => {
        const tId = tenantId || socket.tenantId || 'tenant_costenita';
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tId).order('fecha', { ascending: false }).order('hora', { ascending: false });
        socket.emit('cargar-historial-reservas', reservasDB || []);
    });

    socket.on('marcar-salida-reserva', async (datos) => {
        const tenantId = datos.tenant_id || socket.tenantId || 'tenant_costenita';
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        const horaActual = new Date().toLocaleTimeString('en-US', opciones);

        const { data: resSale } = await supabase.from('reservas').select('*').eq('id', datos.id).single();

        if (resSale) {
            await supabase.from('reservas').update({ estado: 'finalizada', hora_salida: horaActual }).eq('id', datos.id);
            await supabase.from('mesas').update({ estado: 'sucia' }).eq('numero', resSale.mesa_id);

            const { data: reservasAfectadas } = await supabase
                .from('reservas').select('*')
                .eq('tenant_id', tenantId)
                .eq('sucursal', resSale.sucursal).eq('fecha', resSale.fecha).eq('hora', resSale.hora)
                .eq('estado', 'activa').gt('turno_sala', resSale.turno_sala);

            if (reservasAfectadas && reservasAfectadas.length > 0) {
                for (const r of reservasAfectadas) {
                    const nuevoTurno = r.turno_sala - 1;
                    await supabase.from('reservas').update({ turno_sala: nuevoTurno }).eq('id', r.id);
                    io.to(tenantId).emit('notificacion-avance-turno', { idReserva: r.id, nuevoTurno: nuevoTurno });
                }
            }
        }

        await emitirMesasActualizadas(tenantId);
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tenantId).order('fecha', { ascending: false }).order('hora', { ascending: false });
        io.to(tenantId).emit('cargar-historial-reservas', reservasDB || []);
    });

    socket.on('consultar-horarios', async (datos) => {
        const tenantId = datos.tenant_id || socket.tenantId || 'tenant_costenita';
        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tenantId).eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
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
        const tenantId = datos.tenant_id || socket.tenantId || 'tenant_costenita';
        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tenantId).eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
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
        const tenantId = pedido.tenant_id || socket.tenantId || 'tenant_costenita';
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        
        const { data: reservasMismoTurno } = await supabase
            .from('reservas').select('id')
            .eq('tenant_id', tenantId)
            .eq('sucursal', pedido.datosReserva.sucursal).eq('fecha', pedido.datosReserva.fecha).eq('hora', pedido.datosReserva.hora).eq('estado', 'activa');

        let turnoAsignado = (reservasMismoTurno ? reservasMismoTurno.length : 0) + 1;
        pedido.turnoFila = turnoAsignado; 

        await supabase.from('reservas').insert([{ 
            id: pedido.id, tenant_id: tenantId, cliente: pedido.cliente, fecha: pedido.datosReserva.fecha, 
            hora: pedido.datosReserva.hora, personas: pedido.datosReserva.personas, 
            mesa_id: pedido.datosReserva.mesa.numero, estado: 'activa', sucursal: pedido.datosReserva.sucursal,
            turno_sala: turnoAsignado
        }]);

        pedido.esFantasma = true; 
        pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
        pedido.estadoCocinaTexto = (pedido.pago === 'Solo Reserva') ? "Reservó Mesa (Pedirá en Local) 🪑" : ((pedido.pago === 'Tarjeta') ? "Pre-orden Pagada Web ✅" : "Pre-orden Pendiente 💵");

        await supabase.from('pedidos_cocina').insert([{
            id: pedido.id, tenant_id: tenantId, cliente: pedido.cliente, item: pedido.item, pago: pedido.pago, tipo: "Reserva en Local",
            turno_fila: pedido.turnoFila, es_fantasma: pedido.esFantasma, hora_registro: pedido.horaRegistro,
            hora_llegada_estimada: pedido.horaLlegadaEstimada, estado_cocina_texto: pedido.estadoCocinaTexto, datos_reserva: pedido.datosReserva
        }]);

        socket.emit('reserva-confirmada-turno', { idReserva: pedido.id, turno: pedido.turnoFila });
        io.to(tenantId).emit('notificar-cocina', pedido);
    });

    socket.on('obtener-pedidos-cocina', async (tenantId) => {
        const tId = tenantId || socket.tenantId || 'tenant_costenita';
        const { data: pedidosDB } = await supabase.from('pedidos_cocina').select('*').eq('tenant_id', tId).eq('estado', 'pendiente').order('id', { ascending: true });
        const pedidosPendientes = (pedidosDB || []).map(p => ({
            id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
            turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
            horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
        }));
        socket.emit('cargar-pedidos-cocina', pedidosPendientes);
    });

    socket.on('obtener-historial-dia', async (tenantId) => {
        const tId = tenantId || socket.tenantId || 'tenant_costenita';
        const { data: historialDB } = await supabase.from('pedidos_cocina').select('*').eq('tenant_id', tId).eq('estado', 'entregado').order('id', { ascending: false }).limit(100);
        socket.emit('cargar-historial', historialDB || []);
    });

    socket.on('guardar-encuesta-opcional', async (datos) => { 
        const tenantId = datos.tenant_id || socket.tenantId || 'tenant_costenita';
        await supabase.from('clientes_perfil').insert([{ tenant_id: tenantId, cliente: datos.cliente, alergias: datos.alergias, preferencias: datos.preferencias }]); 
    });

    socket.on('pedido-despachado-cocina', async (datos) => {
        const tenantId = datos.tenant_id || socket.tenantId || 'tenant_costenita';
        const pedidoId = datos.id || datos;
        await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', pedidoId); 
        io.to(tenantId).emit('pedido-listo', { idReserva: pedidoId });
    });

    socket.on('cambiar-estado-mesa', async (datos) => { 
        const tenantId = socket.tenantId || 'tenant_costenita';
        await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero); 
        await emitirMesasActualizadas(tenantId); 
    });
    
    socket.on('agregar-nuevo-producto', async (p) => { 
        const tenantId = socket.tenantId || 'tenant_costenita';
        await supabase.from('menu').insert([{ tenant_id: tenantId, nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal }]); 
        await emitirMenuActualizado(tenantId); 
    });
    
    socket.on('editar-producto', async (p) => { 
        const tenantId = socket.tenantId || 'tenant_costenita';
        await supabase.from('menu').update({ nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal }).eq('id', p.id); 
        await emitirMenuActualizado(tenantId); 
    });    
    
    socket.on('eliminar-producto', async (id) => { 
        const tenantId = socket.tenantId || 'tenant_costenita';
        await supabase.from('menu').delete().eq('id', id); 
        await emitirMenuActualizado(tenantId); 
    });
});

// --- SISTEMA DE ALERTAS PRE-RESERVA (Se ejecuta cada minuto) ---
setInterval(async () => {
    const opcionesHora = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false };
    const ahoraEcuador = new Date().toLocaleTimeString('en-US', opcionesHora); 
    const fechaEcuadorFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());

    let [horaActual, minActual] = ahoraEcuador.split(':').map(Number);
    let totalMinutosActuales = (horaActual * 60) + minActual;

    const { data: reservasHoy } = await supabase
        .from('reservas')
        .select('*')
        .eq('fecha', fechaEcuadorFormat)
        .eq('estado', 'activa');

    if (reservasHoy && reservasHoy.length > 0) {
        reservasHoy.forEach(reserva => {
            let [horaReserva, minReserva] = reserva.hora.split(':').map(Number);
            let totalMinutosReserva = (horaReserva * 60) + minReserva;
            let diferenciaMinutos = totalMinutosReserva - totalMinutosActuales;

            if (diferenciaMinutos === 15 || diferenciaMinutos === 14) {
                const tenantAlerta = reserva.tenant_id || 'tenant_costenita';
                io.to(tenantAlerta).emit('alerta-proxima-reserva', {
                    idReserva: reserva.id,
                    sucursal: reserva.sucursal,
                    minutosRestantes: diferenciaMinutos
                });
                console.log(`🔔 Alerta enviada para la reserva #${reserva.id} en ${tenantAlerta} (Faltan ${diferenciaMinutos} min)`);
            }
        });
    }
}, 60000); 

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor Multi-Tenant corriendo en puerto ${PORT}`));