require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 🔐 Conexión blindada a Supabase usando variables de entorno
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Servir los archivos estáticos de la carpeta 'public'
app.use(express.static('public'));

// ⚡ Motor de WebSockets en Tiempo Real
io.on('connection', (socket) => {
    console.log('🟢 Nuevo cliente o pantalla conectada');

    // ----------------------------------------------------
    // 🍔 MÓDULO: MENÚ DINÁMICO (Sin Stock, con descripciones)
    // ----------------------------------------------------
    socket.on('agregar-nuevo-producto', async (producto) => {
        const { data, error } = await supabase.from('menu').insert([producto]).select();
        if (error) {
            console.error('Error al agregar plato:', error);
        } else {
            io.emit('actualizar-menu', data); // Actualiza quioscos en vivo
        }
    });

    socket.on('editar-producto', async (producto) => {
        const { data, error } = await supabase.from('menu').update(producto).eq('id', producto.id).select();
        if (!error) io.emit('actualizar-menu', data);
    });

    // ----------------------------------------------------
    // 👻 MÓDULO: PEDIDOS Y PRE-ÓRDENES FANTASMA
    // ----------------------------------------------------
    socket.on('nuevo-pedido', async (pedido) => {
        // Guarda el pedido en la tabla pedidos_cocina a prueba de caídas
        const { data, error } = await supabase.from('pedidos_cocina').insert([pedido]).select();
        if (error) {
            console.error('Error al guardar pedido:', error);
        } else {
            // Unifica el canal para impactar la cocina al instante
            io.emit('notificar-cocina', pedido); 
        }
    });

    socket.on('pedido-entregado', async (pedidoId) => {
        // Mueve el pedido al historial de ventas del día
        await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', pedidoId);
        io.emit('actualizar-historial');
    });

    // ----------------------------------------------------
    // 📅 MÓDULO: RESERVAS Y CONTROL DE MESAS (Check-out)
    // ----------------------------------------------------
    socket.on('desocupar-mesa', async (reservaId, mesaId) => {
        // Registra la hora exacta de salida
        const checkoutTime = new Date().toLocaleTimeString('es-EC', { timeZone: 'America/Guayaquil' });
        
        await supabase.from('reservas').update({ estado: 'finalizado', checkout: checkoutTime }).eq('id', reservaId);
        await supabase.from('mesas').update({ estado: 'sucia' }).eq('id', mesaId); // Alerta a los meseros
        
        io.emit('actualizar-mesas');
        io.emit('actualizar-filas'); // Avisa a los clientes en la cola dinámica
    });
});

// 🚀 Puerto dinámico para el despliegue en Render
const PORT = process.env.PORT || 3090;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de La Costeñita operando al 100% en el puerto ${PORT}`);
});