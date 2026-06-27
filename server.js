const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir los archivos de la carpeta 'public'
app.use(express.static(path.join(__dirname, 'public')));

// Comunicación en Tiempo Real (Sockets)
io.on('connection', (socket) => {
  console.log('🟢 Nuevo dispositivo conectado al sistema operativo');
  
  // Cuando el quiosco envía un pedido
  socket.on('nuevo-pedido', (pedido) => {
    // Reenviar directamente a la pantalla de la cocina
    io.emit('nuevo-pedido-cocina', pedido);
  });

  // Cuando la cocina despacha un pedido
  socket.on('pedido-despachado', (id) => {
    // Avisar a meseros y admin que el pedido está listo
    io.emit('actualizar-estado-pedido', id);
  });

  socket.on('disconnect', () => {
    console.log('🔴 Dispositivo desconectado');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor SaaS La Costeñita operando en el puerto ${PORT}`);
});