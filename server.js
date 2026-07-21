require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// Validar variables de entorno
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Error crítico: Faltan SUPABASE_URL o SUPABASE_ANON_KEY en el archivo .env');
    process.exit(1);
}

// Inicializar cliente de Supabase
const supabase = createClient(supabaseUrl, supabaseKey);
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Servir archivos estáticos.
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});

io.on('connection', (socket) => {
    let currentTenant = 'tenant_costenita';

    socket.on('unirse-a-restaurante', async (tenantId) => {
        const tid = tenantId || 'tenant_costenita';
        currentTenant = tid;
        socket.join(tid);

        try {
            const [menuRes, mesasRes, cocinaRes, historialRes, reservasRes] = await Promise.all([
                supabase.from('menu').select('*').eq('tenant_id', tid),
                supabase.from('mesas').select('*').eq('tenant_id', tid),
                supabase.from('pedidos').select('*').eq('tenant_id', tid).eq('estado', 'activa'),
                supabase.from('pedidos').select('*').eq('tenant_id', tid).eq('estado', 'completado'),
                supabase.from('pedidos').select('*').eq('tenant_id', tid)
            ]);

            socket.emit('cargar-menu-inicial', menuRes.data || []);
            socket.emit('cargar-mesas-inicial', mesasRes.data || []);
            socket.emit('cargar-pedidos-cocina', cocinaRes.data || []);
            socket.emit('cargar-historial', historialRes.data || []);
            socket.emit('cargar-historial-reservas', reservasRes.data || []);
        } catch (error) {
            console.error('Error al cargar datos iniciales de Supabase:', error);
        }
    });

    // Gestión de Menú
    socket.on('agregar-nuevo-producto', async (prod) => {
        const nuevoProd = {
            tenant_id: currentTenant,
            nombre: prod.nombre,
            precio: prod.precio,
            category: prod.category,
            descripcion: prod.descripcion,
            img: prod.img,
            sucursal: prod.sucursal || 'Todas'
        };

        const { data, error } = await supabase.from('menu').insert([nuevoProd]).select();
        if (!error && data) {
            const { data: menuActualizado } = await supabase.from('menu').select('*').eq('tenant_id', currentTenant);
            io.to(currentTenant).emit('menu-actualizado-completo', menuActualizado);
        }
    });

    socket.on('editar-producto', async (prodEditado) => {
        const { error } = await supabase
            .from('menu')
            .update({
                nombre: prodEditado.nombre,
                precio: prodEditado.precio,
                category: prodEditado.category,
                descripcion: prodEditado.descripcion,
                img: prodEditado.img,
                sucursal: prodEditado.sucursal
            })
            .eq('id', prodEditado.id);

        if (!error) {
            const { data: menuActualizado } = await supabase.from('menu').select('*').eq('tenant_id', currentTenant);
            io.to(currentTenant).emit('menu-actualizado-completo', menuActualizado);
        }
    });

    socket.on('eliminar-producto', async (id) => {
        const { error } = await supabase.from('menu').delete().eq('id', id);
        if (!error) {
            const { data: menuActualizado } = await supabase.from('menu').select('*').eq('tenant_id', currentTenant);
            io.to(currentTenant).emit('menu-actualizado-completo', menuActualizado);
        }
    });

    // Estado de Mesas
    socket.on('cambiar-estado-mesa', async ({ numero, estado }) => {
        await supabase
            .from('mesas')
            .update({ estado })
            .eq('tenant_id', currentTenant)
            .eq('numero', numero);

        const { data: mesasActualizadas } = await supabase.from('mesas').select('*').eq('tenant_id', currentTenant);
        io.to(currentTenant).emit('mesas-actualizadas', mesasActualizadas);
    });

    // Horarios y Disponibilidad
    socket.on('consultar-horarios', async ({ fecha, personas, sucursal, tenant_id }) => {
        const tid = tenant_id || currentTenant;
        const horasBase = ['12:30', '13:00', '13:30', '14:00', '19:00', '19:30', '20:00', '20:30'];
        
        const { data: mesas } = await supabase.from('mesas').select('*').eq('tenant_id', tid);
        const { data: reservas } = await supabase.from('pedidos').select('*').eq('tenant_id', tid).eq('fecha', fecha).eq('sucursal', sucursal);

        const totalMesas = mesas ? mesas.length : 0;
        const horariosRespuesta = horasBase.map(h => {
            const ocupadas = reservas ? reservas.filter(r => r.hora === h && r.estado === 'activa').length : 0;
            const disponibles = Math.max(0, totalMesas - ocupadas);
            return { hora: h, disponibles, lleno: disponibles === 0 };
        });
        socket.emit('horarios-para-fecha', horariosRespuesta);
    });

    socket.on('verificar-disponibilidad', async ({ fecha, hora, personas, sucursal, tenant_id }) => {
        const tid = tenant_id || currentTenant;
        const { data: mesas } = await supabase.from('mesas').select('*').eq('tenant_id', tid).eq('estado', 'disponible');
        socket.emit('resultado-disponibilidad', {
            disponible: true,
            horaExacta: hora,
            sucursal: sucursal,
            mesa: mesas && mesas.length > 0 ? mesas[0] : { numero: 1 }
        });
    });

    // Generación de Reservas y Pedidos
    socket.on('enviar-reserva-pedido', async (pedido) => {
        const tenantKey = pedido.tenant_id || currentTenant;
        const sucursal = pedido.datosReserva ? pedido.datosReserva.sucursal : 'Urdesa';

        const { data: activas } = await supabase
            .from('pedidos')
            .select('*')
            .eq('tenant_id', tenantKey)
            .eq('sucursal', sucursal)
            .eq('estado', 'activa');

        const turnoFila = (activas ? activas.length : 0) + 1;

        const nuevoPedido = {
            tenant_id: tenantKey,
            turno_sala: turnoFila,
            turnoFila: turnoFila,
            estado: 'activa',
            sucursal: sucursal,
            mesa_id: pedido.datosReserva && pedido.datosReserva.mesa ? pedido.datosReserva.mesa.numero : 1,
            cliente: pedido.datosReserva ? pedido.datosReserva.nombre : 'Cliente Invitado',
            fecha: pedido.datosReserva ? pedido.datosReserva.fecha : new Date().toISOString().split('T')[0],
            hora: pedido.datosReserva ? pedido.datosReserva.hora : '13:00',
            personas: pedido.datosReserva ? pedido.datosReserva.personas : 2,
            item: pedido.item || (pedido.productosComprados ? pedido.productosComprados.map(i => `${i.cantidad}x ${i.nombre}`).join(', ') : 'Reserva de Mesa'),
            pago: pedido.pago || 'Tarjeta'
        };

        const { data, error } = await supabase.from('pedidos').insert([nuevoPedido]).select();
        if (!error && data) {
            const pedidoInsertado = data[0];
            
            const { data: pedidosCocina } = await supabase.from('pedidos').select('*').eq('tenant_id', tenantKey).eq('estado', 'activa');
            const { data: reservasTotales } = await supabase.from('pedidos').select('*').eq('tenant_id', tenantKey);

            io.to(tenantKey).emit('notificar-cocina', pedidoInsertado);
            io.to(tenantKey).emit('cargar-pedidos-cocina', pedidosCocina);
            io.to(tenantKey).emit('cargar-historial-reservas', reservasTotales);
        }
    });

    socket.on('obtener-historial-reservas', async (tenantId) => {
        const tid = tenantId || currentTenant;
        const { data } = await supabase.from('pedidos').select('*').eq('tenant_id', tid);
        socket.emit('cargar-historial-reservas', data || []);
    });

    socket.on('obtener-historial-dia', async (tenantId) => {
        const tid = tenantId || currentTenant;
        const { data } = await supabase.from('pedidos').select('*').eq('tenant_id', tid).eq('estado', 'completado');
        socket.emit('cargar-historial', data || []);
    });

    socket.on('obtener-pedidos-cocina', async (tenantId) => {
        const tid = tenantId || currentTenant;
        const { data } = await supabase.from('pedidos').select('*').eq('tenant_id', tid).eq('estado', 'activa');
        socket.emit('cargar-pedidos-cocina', data || []);
    });

    socket.on('pedido-despachado-cocina', async (idPedido) => {
        await supabase
            .from('pedidos')
            .update({ estado: 'completado' })
            .eq('id', idPedido);

        const { data: pedidosCocina } = await supabase.from('pedidos').select('*').eq('tenant_id', currentTenant).eq('estado', 'activa');
        const { data: historialVentas } = await supabase.from('pedidos').select('*').eq('tenant_id', currentTenant).eq('estado', 'completado');

        io.to(currentTenant).emit('cargar-pedidos-cocina', pedidosCocina);
        io.to(currentTenant).emit('cargar-historial', historialVentas);
    });

    socket.on('marcar-salida-reserva', async ({ id, mesa_id, tenant_id }) => {
        const tid = tenant_id || currentTenant;
        
        await supabase
            .from('pedidos')
            .update({ estado: 'finalizada' })
            .eq('id', id);

        const { data: reservasTotales } = await supabase.from('pedidos').select('*').eq('tenant_id', tid);
        io.to(tid).emit('cargar-historial-reservas', reservasTotales);
    });
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Book&Bite conectado a Supabase y corriendo en el puerto ${PORT}`);
});