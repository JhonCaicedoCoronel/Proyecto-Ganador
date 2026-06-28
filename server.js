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
    manejarCocina(io, socket);
    manejarReservas(io, socket);

    // Carga inicial
    const { data: mesas } = await supabase.from('mesas').select('*');
    socket.emit('cargar-mesas-inicial', mesas || []);
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));