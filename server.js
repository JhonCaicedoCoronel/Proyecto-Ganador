require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const { createClient } = require('@supabase/supabase-js');

// Verificación de variables de entorno
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("❌ ERROR CRÍTICO: Faltan credenciales de Supabase en el archivo .env");
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static('public'));
app.get('/', (req, res) => { res.redirect('/quiosco.html'); });

const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];

// --- FUNCIONES DE EMISIÓN GLOBAL POR TENANT ---
async function emitirMenuActualizado(tenantId) {
    try {
        const { data, error } = await supabase.from('menu').select('*').eq('tenant_id', tenantId).order('id', { ascending: true });
        if (error) throw error;
        io.to(tenantId).emit('menu-actualizado-completo', data || []);
    } catch (error) {
        console.error(`⚠️ Error al emitir menú (Tenant: ${tenantId}):`, error.message);
    }
}

async function emitirMesasActualizadas(tenantId) {
    try {
        const { data, error } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
        if (error) throw error;
        io.to(tenantId).emit('mesas-actualizadas', data || []);
    } catch (error) {
        console.error(`⚠️ Error al emitir mesas (Tenant: ${tenantId}):`, error.message);
    }
}

// --- MANEJO DE CONEXIONES SOCKET.IO ---
io.on('connection', (socket) => {
    
    // 1. UNIÓN A SALA MULTI-TENANT
    socket.on('unirse-a-restaurante', async (tenantId) => {
        try {
            const validTenant = tenantId || 'tenant_costenita';
            socket.join(validTenant);
            socket.tenantId = validTenant;

            const { data: estadoMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
            const { data: menuProductos } = await supabase.from('menu').select('*').eq('tenant_id', validTenant).order('id', { ascending: true });
            
            socket.emit('cargar-menu-inicial', menuProductos || []);
            socket.emit('cargar-mesas-inicial', estadoMesas || []);
        } catch (error) {
            console.error('⚠️ Error al inicializar restaurante:', error.message);
        }
    });

    // 2. HISTORIAL DE RESERVAS
    socket.on('obtener-historial-reservas', async (tenantIdInput) => {
        try {
            const tenantId = tenantIdInput || socket.tenantId || 'tenant_costenita';
            const { data, error } = await supabase.from('reservas')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('fecha', { ascending: false })
                .order('hora', { ascending: false });
            
            if (error) throw error;
            socket.emit('cargar-historial-reservas', data || []);
        } catch (error) {
            console.error('⚠️ Error al obtener historial de reservas:', error.message);
        }
    });

    // 3. GESTIÓN OPERATIVA: SALIDA Y AVANCE DE FILA
    socket.on('marcar-salida-reserva', async (datos) => {
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
            const horaActual = new Date().toLocaleTimeString('en-US', opciones);

            const { data: resSale, error: errGet } = await supabase.from('reservas').select('*').eq('id', datos.id).single();
            if (errGet) throw errGet;

            if (resSale) {
                // Actualizar reserva a finalizada y mesa a sucia
                await supabase.from('reservas').update({ estado: 'finalizada', hora_salida: horaActual }).eq('id', datos.id);
                await supabase.from('mesas').update({ estado: 'sucia' }).eq('numero', resSale.mesa_id);

                // Buscar a todos los clientes que estaban DETRÁS en la fila
                const { data: reservasAfectadas } = await supabase.from('reservas')
                    .select('*')
                    .eq('tenant_id', tenantId)
                    .eq('sucursal', resSale.sucursal)
                    .eq('fecha', resSale.fecha)
                    .eq('estado', 'activa')
                    .gt('turno_sala', resSale.turno_sala);

                // Hacer avanzar la fila
                if (reservasAfectadas && reservasAfectadas.length > 0) {
                    for (const r of reservasAfectadas) {
                        const nuevoTurno = r.turno_sala - 1;
                        // Actualizar BD de Reservas
                        await supabase.from('reservas').update({ turno_sala: nuevoTurno }).eq('id', r.id);
                        // Actualizar BD de Cocina (KDS)
                        await supabase.from('pedidos_cocina').update({ turno_fila: nuevoTurno }).eq('id', r.id);
                        
                        // Notificar al celular del cliente
                        io.to(tenantId).emit('notificacion-avance-turno', { idReserva: r.id, nuevoTurno: nuevoTurno });
                    }
                    
                    // Forzar refresco en la pantalla de la cocina
                    const { data: pedidosRefresh } = await supabase.from('pedidos_cocina').select('*').eq('tenant_id', tenantId).eq('estado', 'pendiente').order('id', { ascending: true });
                    if(pedidosRefresh) {
                        const pedidosPendientes = pedidosRefresh.map(p => ({
                            id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
                            turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
                            horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
                        }));
                        io.to(tenantId).emit('cargar-pedidos-cocina', pedidosPendientes);
                    }
                }
            }

            await emitirMesasActualizadas(tenantId);
            
            const { data: reservasActualizadas } = await supabase.from('reservas')
                .select('*').eq('tenant_id', tenantId)
                .order('fecha', { ascending: false }).order('hora', { ascending: false });
            io.to(tenantId).emit('cargar-historial-reservas', reservasActualizadas || []);

        } catch (error) {
            console.error('⚠️ Error al marcar salida y avanzar fila:', error.message);
        }
    });

    // 4. VERIFICACIÓN DE DISPONIBILIDAD
    socket.on('consultar-horarios', async (datos) => {
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            const personasRequeridas = parseInt(datos.personas) || 1;
            
            const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tenantId).eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
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
        } catch (error) {
            console.error('⚠️ Error al consultar horarios:', error.message);
        }
    });

    socket.on('verificar-disponibilidad', async (datos) => {
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            const personasRequeridas = parseInt(datos.personas) || 1;
            
            const { data: reservasDB } = await supabase.from('reservas').select('*').eq('tenant_id', tenantId).eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
            const { data: mesasDB } = await supabase.from('mesas').select('*');
            
            const reservasGlobales = reservasDB || []; 
            const mesasTotales = mesasDB || [];

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
        } catch (error) {
            console.error('⚠️ Error al verificar disponibilidad:', error.message);
        }
    });

    // 5. FLUJO PRINCIPAL: CHECKOUT DE PEDIDOS Y GENERACIÓN DE TURNOS
    socket.on('enviar-reserva-pedido', async (pedido) => {
        try {
            const tenantId = pedido.tenant_id || socket.tenantId || 'tenant_costenita';
            const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
            pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
            
            // BUSCAR EL ÚLTIMO TURNO DE LA FILA (Máximo)
            const { data: reservasActivas } = await supabase.from('reservas').select('turno_sala')
                .eq('tenant_id', tenantId)
                .eq('sucursal', pedido.datosReserva.sucursal)
                .eq('fecha', pedido.datosReserva.fecha)
                .eq('estado', 'activa');

            let turnoAsignado = 1;
            if (reservasActivas && reservasActivas.length > 0) {
                // Obtener el número de turno más alto en la sala
                const maxTurno = Math.max(...reservasActivas.map(r => r.turno_sala || 0));
                turnoAsignado = maxTurno + 1; // Asignar el siguiente
            }
            pedido.turnoFila = turnoAsignado; 

            // Registrar Reserva
            const { error: errReserva } = await supabase.from('reservas').insert([{ 
                id: pedido.id, tenant_id: tenantId, cliente: pedido.cliente, fecha: pedido.datosReserva.fecha, 
                hora: pedido.datosReserva.hora, personas: pedido.datosReserva.personas, 
                mesa_id: pedido.datosReserva.mesa.numero, estado: 'activa', sucursal: pedido.datosReserva.sucursal,
                turno_sala: turnoAsignado
            }]);
            if (errReserva) throw errReserva;

            pedido.esFantasma = true; 
            pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
            pedido.estadoCocinaTexto = (pedido.pago === 'N/A') ? "Reservó Mesa (Pedirá en Local) 🪑" : ((pedido.pago === 'Tarjeta') ? "Pre-orden Pagada Web ✅" : "Pre-orden Pendiente 💵");

            // Registrar Pedido en Cocina
            const { error: errCocina } = await supabase.from('pedidos_cocina').insert([{
                id: pedido.id, tenant_id: tenantId, cliente: pedido.cliente, item: pedido.item, pago: pedido.pago, tipo: "Reserva en Local",
                turno_fila: pedido.turnoFila, es_fantasma: pedido.esFantasma, hora_registro: pedido.horaRegistro,
                hora_llegada_estimada: pedido.horaLlegadaEstimada, estado_cocina_texto: pedido.estadoCocinaTexto, datos_reserva: pedido.datosReserva,
                estado: 'pendiente'
            }]);
            if (errCocina) throw errCocina;

            // Emitir respuestas OMNICANAL
            socket.emit('reserva-confirmada-turno', { idReserva: pedido.id, turno: pedido.turnoFila });
            io.to(tenantId).emit('notificar-cocina', pedido);
            
            // Actualizar historiales
            const { data: nuevasReservas } = await supabase.from('reservas').select('*').eq('tenant_id', tenantId).order('fecha', { ascending: false }).order('hora', { ascending: false });
            io.to(tenantId).emit('cargar-historial-reservas', nuevasReservas || []);

        } catch (error) {
            console.error('❌ Error Crítico al procesar orden:', error.message);
        }
    });

    // 6. CONTROL DE COCINA Y KDS
    socket.on('obtener-pedidos-cocina', async (tenantIdInput) => {
        try {
            const tenantId = tenantIdInput || socket.tenantId || 'tenant_costenita';
            const { data, error } = await supabase.from('pedidos_cocina').select('*').eq('tenant_id', tenantId).eq('estado', 'pendiente').order('id', { ascending: true });
            if (error) throw error;

            const pedidosPendientes = (data || []).map(p => ({
                id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
                turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
                horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
            }));
            socket.emit('cargar-pedidos-cocina', pedidosPendientes);
        } catch (error) {
            console.error('⚠️ Error al obtener pedidos de cocina:', error.message);
        }
    });

    socket.on('pedido-despachado-cocina', async (datos) => { 
        try {
            const tenantId = datos.tenant_id || socket.tenantId || 'tenant_costenita';
            const pedidoId = datos.id || datos;
            
            await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', pedidoId); 
            io.to(tenantId).emit('pedido-listo', { idReserva: pedidoId });
            
            const { data: historialDB } = await supabase.from('pedidos_cocina').select('*').eq('tenant_id', tenantId).eq('estado', 'entregado').order('id', { ascending: false }).limit(100);
            io.to(tenantId).emit('cargar-historial', historialDB || []);
        } catch (error) {
            console.error('⚠️ Error al despachar pedido:', error.message);
        }
    });

    // 7. HISTORIAL Y ADMINISTRACIÓN
    socket.on('obtener-historial-dia', async (tenantIdInput) => {
        try {
            const tenantId = tenantIdInput || socket.tenantId || 'tenant_costenita';
            const { data, error } = await supabase.from('pedidos_cocina').select('*').eq('tenant_id', tenantId).eq('estado', 'entregado').order('id', { ascending: false }).limit(100);
            if (error) throw error;
            socket.emit('cargar-historial', data || []);
        } catch (error) {
            console.error('⚠️ Error al obtener historial:', error.message);
        }
    });

    socket.on('cambiar-estado-mesa', async (datos) => { 
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero); 
            await emitirMesasActualizadas(tenantId); 
        } catch (error) {
            console.error('⚠️ Error al cambiar estado de mesa:', error.message);
        }
    });
    
    // 8. EDITOR DE MENÚ
    socket.on('agregar-nuevo-producto', async (p) => { 
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            await supabase.from('menu').insert([{ tenant_id: tenantId, nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal }]); 
            await emitirMenuActualizado(tenantId); 
        } catch (error) {
            console.error('⚠️ Error al agregar producto:', error.message);
        }
    });
    
    socket.on('editar-producto', async (p) => { 
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            await supabase.from('menu').update({ nombre: p.nombre, precio: p.precio, category: p.category, img: p.img, descripcion: p.descripcion, sucursal: p.sucursal }).eq('id', p.id); 
            await emitirMenuActualizado(tenantId); 
        } catch (error) {
            console.error('⚠️ Error al editar producto:', error.message);
        }
    });    
    
    socket.on('eliminar-producto', async (id) => { 
        try {
            const tenantId = socket.tenantId || 'tenant_costenita';
            await supabase.from('menu').delete().eq('id', id); 
            await emitirMenuActualizado(tenantId); 
        } catch (error) {
            console.error('⚠️ Error al eliminar producto:', error.message);
        }
    });
});

// --- SISTEMA DE ALERTAS PRE-RESERVA CRONOMETRADO ---
setInterval(async () => {
    try {
        const opcionesHora = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: false };
        const ahoraEcuador = new Date().toLocaleTimeString('en-US', opcionesHora); 
        const fechaEcuadorFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Guayaquil' }).format(new Date());

        let [horaActual, minActual] = ahoraEcuador.split(':').map(Number);
        let totalMinutosActuales = (horaActual * 60) + minActual;

        const { data: reservasHoy, error } = await supabase
            .from('reservas')
            .select('*')
            .eq('fecha', fechaEcuadorFormat)
            .eq('estado', 'activa');

        if (error) throw error;

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
                    
                    console.log(`🔔 Alerta cronometrada enviada: Reserva #${reserva.id} | Franquicia: ${tenantAlerta}`);
                }
            });
        }
    } catch (error) {
        console.error('⚠️ Error en el sistema de alertas pre-reserva:', error.message);
    }
}, 60000); 

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor Multi-Tenant (Blindado) corriendo en puerto ${PORT}`));