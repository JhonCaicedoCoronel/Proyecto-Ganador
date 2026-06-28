require('dotenv').config();
const express = require('express');
const path = require('path');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const supabase = require(path.join(__dirname, 'db'));

const manejarCocina = require(path.join(__dirname, 'sockets/cocina'));
const manejarReservas = require(path.join(__dirname, 'sockets/reservas'));

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', async (socket) => {
    console.log(`Cliente conectado: ${socket.id}`);

    try {
        // Carga forzada de tablas necesarias para la interfaz
        const { data: menu } = await supabase.from('menu').select('*');
        const { data: mesas } = await supabase.from('mesas').select('*');
        
        // Enviamos los datos específicamente al socket que acaba de entrar
        socket.emit('cargar-menu-inicial', menu || []);
        socket.emit('cargar-mesas-inicial', mesas || []);
    } catch (err) {
        console.error('❌ Error fatal en carga inicial:', err.message);
    }

    // Luego delegamos los sockets
    manejarCocina(io, socket);
    manejarReservas(io, socket);
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));