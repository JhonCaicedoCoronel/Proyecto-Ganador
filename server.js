const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" } // Permite conexiones desde cualquier dispositivo (tablet, celular, pc)
});

// Servir archivos estáticos (aquí pondremos las pantallas más adelante)
app.use(express.static('public'));
// Redireccionar la raíz automáticamente al quiosco
app.get('/', (req, res) => {
    res.redirect('/quiosco.html');
});

// Conexión de Socket.io
io.on('connection', (socket) => {
    console.log('📱 Un dispositivo se ha conectado: ' + socket.id);

    // ESCUCHAR CAMBIOS EN EL MENÚ (Admin -> Servidor -> Clientes)

    // 1. Cuando el admin cambia la disponibilidad (Agotado / Disponible)
    socket.on('actualizar-disponibilidad', (datos) => {
        console.log(`🔄 Cambio de stock para producto ${datos.id}: Disponible = ${datos.disponible}`);
        // Retransmite a todos los clientes la actualización
        io.emit('menu-disponibilidad-actualizada', datos);
    });

    // 2. Cuando el admin añade un plato nuevo o edita precios
    socket.on('actualizar-menu-completo', (nuevoMenu) => {
        console.log('🍔 El menú global ha sido actualizado por el administrador');
        // Manda el nuevo menú a todos los quioscos y teléfonos
        io.emit('actualizar-pantalla-clientes', nuevoMenu);
    });
    
    // 1. Escuchar cuando el Quiosco o la Web envían un pedido
    socket.on('enviar-pedido', (pedido) => {
        console.log('🍔 ¡Nuevo pedido recibido en el servidor!', pedido);
        
        // Asignar una hora de llegada al servidor para asegurar precisión
        pedido.horaRegistro = new Date().toLocaleTimeString('es-EC', {
            timeZone: 'America/Guayaquil',
            hour12: true,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
    });
        

        // 2. Retransmitir el pedido INSTANTÁNEAMENTE a la pantalla de la cocina
        io.emit('notificar-cocina', pedido);
    });

    socket.on('disconnect', () => {
        console.log('❌ Dispositivo desconectado');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});