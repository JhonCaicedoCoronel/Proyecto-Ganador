require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const { createClient } = require('@supabase/supabase-js');

// Conexión estable con Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static('public'));

// --- RUTA RAÍZ ---
app.get('/', (req, res) => { 
    res.sendFile(__dirname + '/public/index.html'); 
});

const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];

async function emitirMenuActualizado(tenant_id) {
    if (!tenant_id) return;
    const { data: menuProductos } = await supabase.from('menu').select('*').eq('tenant_id', tenant_id).order('id', { ascending: true });
    io.to(tenant_id).emit('menu-actualizado-completo', menuProductos || []);
}

async function emitirMesasActualizadas(tenant_id) {
    if (!tenant_id) return;
    const { data: estadoMesas } = await supabase.from('mesas').select('*').eq('tenant_id', tenant_id).order('numero', { ascending: true });
    io.to(tenant_id).emit('mesas-actualizadas', estadoMesas || []);
}

io.on('connection', (socket) => {
    // Variable de respaldo local para este socket específico
    let socketTenantId = null;

    // EVENTO CLAVE: Se ejecuta al abrir cualquier pantalla para enlazar la sala en tiempo real
    socket.on('unirse-a-restaurante', async (tenant_id) => {
        if (!tenant_id) return;
        socketTenantId = tenant_id;
        socket.join(tenant_id); 
        console.log(`📡 Dispositivo sincronizado al entorno SaaS del local: ${tenant_id}`);
        
        // Carga inmediata de datos iniciales
        const { data: estadoMesas } = await supabase.from('mesas').select('*').eq('tenant_id', tenant_id).order('numero', { ascending: true });
        const { data: menuProductos } = await supabase.from('menu').select('*').eq('tenant_id', tenant_id).order('id', { ascending: true });
        
        socket.emit('cargar-menu-inicial', menuProductos || []);
        socket.emit('cargar-mesas-inicial', estadoMesas || []);
    });

    // OBTENER HISTORIAL DE RESERVAS (Evita que salga vacío al recargar)
    socket.on('obtener-historial-reservas', async (paramTenantId) => {
        const tenantConsulta = paramTenantId || socketTenantId;
        if (!tenantConsulta) return console.log("⚠️ Intento de consulta de reservas sin tenant_id");

        const { data: reservasDB } = await supabase.from('reservas')
            .select('*')
            .eq('tenant_id', tenantConsulta)
            .order('fecha', { ascending: false })
            .order('hora', { ascending: false });
        socket.emit('cargar-historial-reservas', reservasDB || []);
    });

    // MARCAR SALIDA Y AVANZAR TURNOS AUTOMÁTICAMENTE
    socket.on('marcar-salida-reserva', async (datos) => {
        const tenantConsulta = datos.tenant_id || socketTenantId;
        if (!tenantConsulta) return;

        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        const horaActual = new Date().toLocaleTimeString('en-US', opciones);

        const { data: resSale } = await supabase.from('reservas').select('*').eq('id', datos.id).eq('tenant_id', tenantConsulta).single();

        if (resSale) {
            await supabase.from('reservas').update({ estado: 'finalizada', hora_salida: horaActual }).eq('id', datos.id).eq('tenant_id', tenantConsulta);
            await supabase.from('mesas').update({ estado: 'sucia' }).eq('numero', datos.mesa_id).eq('tenant_id', tenantConsulta);

            // Algoritmo de avance de fila virtual
            const { data: reservasAfectadas } = await supabase
                .from('reservas').select('*')
                .eq('tenant_id', tenantConsulta)
                .eq('sucursal', resSale.sucursal).eq('fecha', resSale.fecha).eq('hora', resSale.hora)
                .eq('estado', 'activa').gt('turno_sala', resSale.turno_sala);

            if (reservasAfectadas && reservasAfectadas.length > 0) {
                for (const r of reservasAfectadas) {
                    const nuevoTurno = r.turno_sala - 1;
                    await supabase.from('reservas').update({ turno_sala: nuevoTurno }).eq('id', r.id).eq('tenant_id', tenantConsulta);
                    io.to(tenantConsulta).emit('notificacion-avance-turno', { idReserva: r.id, nuevoTurno: nuevoTurno });
                }
            }
        }

        await emitirMesasActualizadas(tenantConsulta);
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tenantConsulta).order('fecha', { ascending: false }).order('hora', { ascending: false });
        io.to(tenantConsulta).emit('cargar-historial-reservas', reservasDB || []);
    });

    // CONSULTA MATEMÁTICA DE HORARIOS DISPONIBLES
    socket.on('consultar-horarios', async (datos) => {
        const tenantConsulta = datos.tenant_id || socketTenantId; 
        if (!tenantConsulta) return;

        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha).eq('estado', 'activa').eq('tenant_id', tenantConsulta).eq('sucursal', datos.sucursal);
        const { data: mesasDB } = await supabase.from('mesas').select('*').eq('tenant_id', tenantConsulta);
        
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

    // VERIFICAR DISPONIBILIDAD Y RETORNAR MESA ÓPTIMA
    socket.on('verificar-disponibilidad', async (datos) => {
        const tenantConsulta = datos.tenant_id || socketTenantId;
        if (!tenantConsulta) return;

        const personasRequeridas = parseInt(datos.personas) || 1;
        const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha).eq('estado', 'activa').eq('tenant_id', tenantConsulta).eq('sucursal', datos.sucursal);
        const { data: mesasDB } = await supabase.from('mesas').select('*').eq('tenant_id', tenantConsulta);
        
        const reservasGlobales = reservasDB || []; 
        const mesasTotales = mesasDB || [];

        const reservasTurno = reservasGlobales.filter(r => r.hora === datos.hora);
        const mesasOcupadasIds = reservasTurno.map(r => r.mesa_id);
        const mesasLibres = mesasTotales.filter(m => !mesasOcupadasIds.includes(m.numero));
        const mesasAptas = mesasLibres.filter(m => m.capacidad >= personasRequeridas);

        if (mesasAptas.length > 0) {
            mesasAptas.sort((a, b) => a.capacidad - b.capacidad);
            socket.emit('resultado-disponibilidad', { disponible: true, horaExacta: datos.hora, mesa: mesasAptas[0], sucursal: datos.sucursal, tenant_id: tenantConsulta });
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

    // RECEPCIÓN DE PREORDEN Y CREACIÓN ESTRUCTURADA EN TABLAS
    socket.on('enviar-reserva-pedido', async (pedido) => {
        const tenantConsulta = pedido.tenant_id || socketTenantId;
        if (!tenantConsulta) return;

        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        pedido.tenant_id = tenantConsulta; 
        
        const { data: reservasMismoTurno } = await supabase
            .from('reservas').select('id')
            .eq('tenant_id', tenantConsulta)
            .eq('sucursal', pedido.datosReserva.sucursal).eq('fecha', pedido.datosReserva.fecha).eq('hora', pedido.datosReserva.hora).eq('estado', 'activa');

        let turnoAsignado = (reservasMismoTurno ? reservasMismoTurno.length : 0) + 1;
        pedido.turnoFila = turnoAsignado; 

        // 1. Inserción en la tabla reservas
        await supabase.from('reservas').insert([{ 
            id: pedido.id, cliente: pedido.cliente, fecha: pedido.datosReserva.fecha, 
            hora: pedido.datosReserva.hora, personas: pedido.datosReserva.personas, 
            mesa_id: pedido.datosReserva.mesa.numero, estado: 'activa', sucursal: pedido.datosReserva.sucursal,
            turno_sala: turnoAsignado, tenant_id: tenantConsulta 
        }]);

        pedido.esFantasma = true; 
        pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
        pedido.estadoCocinaTexto = (pedido.pago === 'Solo Reserva') ? "Reservó Mesa (Pedirá en Local) 🪑" : ((pedido.pago === 'Tarjeta') ? "Pre-orden Pagada Web ✅" : "Pre-orden Pendiente 💵");

        // 2. Inserción en la tabla pedidos_cocina con estado 'pendiente'
        await supabase.from('pedidos_cocina').insert([{
            id: pedido.id, cliente: pedido.cliente, item: pedido.item, pago: pedido.pago, tipo: "Reserva en Local",
            turno_fila: pedido.turnoFila, es_fantasma: pedido.esFantasma, hora_registro: pedido.horaRegistro,
            hora_llegada_estimada: pedido.horaLlegadaEstimada, estado_cocina_texto: pedido.estadoCocinaTexto, 
            datos_reserva: pedido.datosReserva, estado: 'pendiente', tenant_id: tenantConsulta 
        }]);

        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        
        io.to(tenantConsulta).emit('notificar-cocina', pedido);
        io.to(tenantConsulta).emit('reserva-confirmada-actualizar', pedido.datosReserva.fecha);
    });

    // OBTENER PEDIDOS ACTIVOS PARA LA COCINA (Persistente al recargar)
    socket.on('obtener-pedidos-cocina', async (paramTenantId) => {
        const tenantConsulta = paramTenantId || socketTenantId;
        if (!tenantConsulta) return;

        const { data: pedidosDB } = await supabase.from('pedidos_cocina')
            .select('*')
            .eq('estado', 'pendiente')
            .eq('tenant_id', tenantConsulta)
            .order('id', { ascending: true });

        const pedidosPendientes = (pedidosDB || []).map(p => ({
            id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
            turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
            horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
        }));
        socket.emit('cargar-pedidos-cocina', pedidosPendientes);
    });

    // OBTENER HISTORIAL DE VENTAS DEL DÍA (Carga registros con estado 'entregado')
    socket.on('obtener-historial-dia', async (paramTenantId) => {
        const tenantConsulta = paramTenantId || socketTenantId;
        if (!tenantConsulta) return;

        const { data: historialDB } = await supabase.from('pedidos_cocina')
            .select('*')
            .eq('estado', 'entregado')
            .eq('tenant_id', tenantConsulta)
            .order('id', { ascending: false })
            .limit(100);
        socket.emit('cargar-historial', historialDB || []);
    });

    // DESPACHAR PEDIDO DESDE EL KDS DE COCINA
    socket.on('pedido-despachado-cocina', async (id) => { 
        const tenantConsulta = socketTenantId;
        if (!tenantConsulta) return;

        // Pasa de 'pendiente' a 'entregado'
        await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', id).eq('tenant_id', tenantConsulta); 
        
        io.to(tenantConsulta).emit('pedido-listo-retirar', id); 
        
        // Refrescar paneles de forma reactiva
        const { data: pedidosDB } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'pendiente').eq('tenant_id', tenantConsulta);
        const pedidosPendientes = (pedidosDB || []).map(p => ({
            id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
            turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
            horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
        }));
        io.to(tenantConsulta).emit('cargar-pedidos-cocina', pedidosPendientes);

        const { data: historialDB } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'entregado').eq('tenant_id', tenantConsulta).order('id', { ascending: false });
        io.to(tenantConsulta).emit('cargar-historial', historialDB || []);
    });

    // GUARDAR ENCUESTA DE SATISFACCIÓN O PREFERENCIAS
    socket.on('guardar-encuesta-opcional', async (datos) => { 
        const tenantConsulta = datos.tenant_id || socketTenantId;
        await supabase.from('clientes_perfil').insert([{ cliente: datos.cliente, allergies: datos.alergias, preferencias: datos.preferencias, tenant_id: tenantConsulta }]); 
    });
    
    // CONTROL DE MAPA DE SALA
    socket.on('cambiar-estado-mesa', async (datos) => { 
        const tenantConsulta = socketTenantId;
        if (!tenantConsulta) return;
        await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero).eq('tenant_id', tenantConsulta); 
        await emitirMesasActualizadas(tenantConsulta); 
    });
    
    // CRUD DEL INVENTARIO / MENÚ
    socket.on('agregar-nuevo-producto', async (p) => { 
        const tenantConsulta = socketTenantId;
        if (!tenantConsulta) return;
        const { error } = await supabase.from('menu').insert([{ 
            nombre: p.nombre, precio: p.precio, category: p.category, 
            img: p.img, descripcion: p.descripcion, sucursal: p.sucursal, tenant_id: tenantConsulta 
        }]); 
        if (error) console.error("❌ Error Supabase Insert:", error.message);
        else await emitirMenuActualizado(tenantConsulta); 
    });
    
    socket.on('editar-producto', async (p) => { 
        const tenantConsulta = socketTenantId;
        if (!tenantConsulta) return;
        const { error } = await supabase.from('menu').update({ 
            nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal 
        }).eq('id', p.id).eq('tenant_id', tenantConsulta); 
        if (error) console.error("❌ Error Supabase Update:", error.message);
        else await emitirMenuActualizado(tenantConsulta); 
    });    
    
    socket.on('eliminar-producto', async (id) => { 
        const tenantConsulta = socketTenantId;
        if (!tenantConsulta) return;
        await supabase.from('menu').delete().eq('id', id).eq('tenant_id', tenantConsulta); 
        await emitirMenuActualizado(tenantConsulta); 
    });
});

// ALERTAS TEMPORALES EN TIEMPO REAL (Cada 60s)
setInterval(async () => {
    const opcionesHora = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false };
    const ahoraEcuador = new Date().toLocaleTimeString('en-US', opcionesHora); 
    const fechaEcuadorFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());

    let [horaActual, minActual] = ahoraEcuador.split(':').map(Number);
    let totalMinutosActuales = (horaActual * 60) + minActual;

    const { data: reservasHoy } = await supabase.from('reservas').select('*').eq('fecha', fechaEcuadorFormat).eq('estado', 'activa');

    if (reservasHoy && reservasHoy.length > 0) {
        reservasHoy.forEach(reserva => {
            let [horaReserva, minReserva] = reserva.hora.split(':').map(Number);
            let totalMinutosReserva = (horaReserva * 60) + minReserva;
            let diferenciaMinutos = totalMinutosReserva - totalMinutosActuales;

            if (diferenciaMinutos === 15 || diferenciaMinutos === 14) {
                io.to(reserva.tenant_id).emit('alerta-proxima-reserva', {
                    idReserva: reserva.id, sucursal: reserva.sucursal, minutosRestantes: diferenciaMinutos
                });
            }
        });
    }
}, 60000); 

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor Multi-tenant corriendo con éxito en puerto ${PORT}`));