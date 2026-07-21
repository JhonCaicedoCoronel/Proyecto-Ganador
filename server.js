require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Conexión oficial a tu Base de Datos de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// Ruta raíz y del quiosco
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/quiosco.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'quiosco.html')); });

// Lógica matemática automatizada para actualizar y desplazar la fila en Supabase
async function recalcularFila(tenantId) {
    try {
        // Obtenemos los pedidos activos en preparación ordenados por su orden de llegada
        const { data: pedidosActivos } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('estado', 'activa')
            .order('id', { ascending: true });

        if (pedidosActivos && pedidosActivos.length > 0) {
            for (let i = 0; i < pedidosActivos.length; i++) {
                const nuevoTurno = i + 1;
                
                // Actualizamos el turno real en Supabase
                await supabase
                    .from('pedidos')
                    .update({ turno_sala: nuevoTurno })
                    .eq('id', pedidosActivos[i].id);

                // Notificamos en vivo al cliente respectivo sobre su avance de posición
                io.to(tenantId).emit('notificacion-avance-turno', { 
                    idReserva: pedidosActivos[i].id, 
                    nuevoTurno: nuevoTurno 
                });
            }
        }
        
        // Enviamos la lista blindada actualizada a la Cocina (KDS)
        const { data: KDSActualizado } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('estado', 'activa')
            .order('id', { ascending: true });
            
        io.to(tenantId).emit('cargar-pedidos-cocina', KDSActualizado || []);
    } catch (err) {
        console.error("Error al recalcular la fila virtual:", err);
    }
}

io.on('connection', (socket) => {

    socket.on('unirse-a-restaurante', async (tenantId) => {
        socket.join(tenantId);
        
        // Sincronización Inicial Fricción 0 desde Supabase
        const { data: productos } = await supabase.from('menu').select('*').eq('tenant_id', tenantId);
        const { data: mesas } = await supabase.from('mesas').select('*').eq('tenant_id', tenantId);
        
        socket.emit('cargar-menu-inicial', productos || []);
        socket.emit('cargar-mesas-inicial', mesas || []);
    });

    // ================= 👨‍🍳 KDS BLINDADO DESDE BASE DE DATOS =================
    socket.on('obtener-pedidos-cocina', async (tenantId) => {
        if (!tenantId) return;
        const { data: pedidos } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('estado', 'activa')
            .order('id', { ascending: true });
            
        socket.emit('cargar-pedidos-cocina', pedidos || []);
    });

    socket.on('pedido-despachado-cocina', async (data) => {
        // Cambiamos el estado en Supabase a 'completado' (va directo al historial de ventas)
        await supabase
            .from('pedidos')
            .update({ estado: 'completado', turno_sala: 0 })
            .eq('id', data.id)
            .eq('tenant_id', data.tenant_id);

        // Notificación push inmediata al comensal en sala
        io.to(data.tenant_id).emit('pedido-listo', { idReserva: data.id });

        // Actualizamos los paneles administrativos de ventas e historial simultáneamente
        const { data: historialActualizado } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', data.tenant_id)
            .eq('estado', 'completado')
            .order('id', { ascending: false });
            
        io.to(data.tenant_id).emit('cargar-historial', historialActualizado || []);

        // Movemos automáticamente la fila y reajustamos los turnos de los que siguen esperando
        await recalcularFila(data.tenant_id);
    });

    // ================= 📱 QUIOSCO CON ASIGNACIÓN AUTOMÁTICA DE TURNOS =================
    socket.on('enviar-reserva-pedido', async (pedido) => {
        try {
            console.log("📥 Recibiendo orden del Quiosco de:", pedido.cliente);
            const tenantId = pedido.tenant_id;
            
            // Consultamos la base de datos para ver el turno
            const { data: activos, error: errConsulta } = await supabase
                .from('pedidos')
                .select('id')
                .eq('tenant_id', tenantId)
                .eq('estado', 'activa');
                
            if (errConsulta) console.error("⚠️ Error consultando turnos:", errConsulta);
                
            const turnoAutomatico = (activos ? activos.length : 0) + 1;

            const nuevoPedidoDB = {
                id: pedido.id,
                tenant_id: tenantId,
                cliente: pedido.cliente,
                sucursal: pedido.datosReserva?.sucursal || 'Principal',
                mesa_id: parseInt(pedido.datosReserva?.mesa) || 1,
                fecha: pedido.datosReserva?.fecha || new Date().toLocaleDateString(),
                hora: pedido.datosReserva?.hora || new Date().toLocaleTimeString(),
                personas: parseInt(pedido.datosReserva?.personas) || 1,
                item: pedido.item,
                pago: pedido.pago,
                estado: 'activa',
                turno_sala: turnoAutomatico
            };

            // Guardamos en Supabase
            const { error: errInsert } = await supabase.from('pedidos').insert([nuevoPedidoDB]);
            
            if (errInsert) {
                console.error("❌ ERROR CRÍTICO AL GUARDAR EN SUPABASE:", errInsert);
                return; // Detenemos la ejecución si falla
            } else {
                console.log("✅ Pedido guardado en Supabase con éxito. Turno:", turnoAutomatico);
            }

            // Si todo salió bien, emitimos a las pantallas
            socket.emit('reserva-confirmada-turno', { turno: turnoAutomatico, idReserva: pedido.id });
            io.to(tenantId).emit('notificar-cocina', nuevoPedidoDB);
            
            const { data: todasLasReservas } = await supabase
                .from('pedidos')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('id', { ascending: false });
            io.to(tenantId).emit('cargar-historial-reservas', todasLasReservas || []);

        } catch (errorGeneral) {
            console.error("🔥 ERROR EN EL SERVIDOR:", errorGeneral);
        }
    });

    // ================= 📈 PANELES ADMINISTRATIVOS (HISTORIAL Y RESERVAS) =================
    socket.on('obtener-historial-dia', async (tenantId) => {
        const { data: completados } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', tenantId)
            .eq('estado', 'completado')
            .order('id', { ascending: false });
        socket.emit('cargar-historial', completados || []);
    });

    socket.on('obtener-historial-reservas', async (tenantId) => {
        const { data: reservas } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', tenantId)
            .order('id', { ascending: false });
        socket.emit('cargar-historial-reservas', reservas || []);
    });

    socket.on('marcar-salida-reserva', async (data) => {
        // Finalizamos la reserva marcando la salida en Supabase
        await supabase
            .from('pedidos')
            .update({ estado: 'finalizada' })
            .eq('id', data.id)
            .eq('tenant_id', data.tenant_id);

        const { data: reservas } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', data.tenant_id)
            .order('id', { ascending: false });
            
        io.to(data.tenant_id).emit('cargar-historial-reservas', reservas || []);
    });

    // Simuladores rápidos de contingencia requeridos por la UI
    socket.on('verificar-disponibilidad', (data) => {
        socket.emit('resultado-disponibilidad', { disponible: true, horaExacta: data.hora, sucursal: data.sucursal, mesa: Math.floor(Math.random() * 8) + 1 });
    });
    socket.on('consultar-horarios', () => {
        socket.emit('horarios-para-fecha', [{ hora: '12:00 PM', disponibles: 4, lleno: false }, { hora: '13:00 PM', disponibles: 2, lleno: false }]);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`🚀 Servidor enlazado a Supabase corriendo en el puerto ${PORT}`); });
