const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" } 
});

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.redirect('/quiosco.html');
});

// NUEVO: La lista oficial del menú ahora vive en el servidor
let menuProductos = [
    { id: 1, nombre: "Combo Frank's Triple", precio: 11.50, category: "combos", img: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500", disponible: true },
    { id: 2, nombre: "Combo Hamburguesa Guayaca", precio: 9.00, category: "combos", img: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=500", disponible: true },
    { id: 3, nombre: "Combo Crispy Chicken", precio: 9.50, category: "combos", img: "https://images.unsplash.com/photo-1625813506062-0aeb1d7a094b?w=500", disponible: true },
    { id: 4, nombre: "Coca-Cola Personal", precio: 1.50, category: "bebidas", img: "https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500", disponible: true },
    { id: 5, nombre: "Té Frío de la Casa", precio: 1.75, category: "bebidas", img: "https://images.unsplash.com/photo-1497534446932-c925b458314e?w=500", disponible: true }
];

io.on('connection', (socket) => {
    console.log('📱 Dispositivo conectado: ' + socket.id);

    // Enviar el menú actual apenas se conecte un cliente o el admin
    socket.emit('cargar-menu-inicial', menuProductos);

    // Escuchar pedidos
    socket.on('enviar-pedido', (pedido) => {
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        io.emit('notificar-cocina', pedido);
    });

    // Cambiar disponibilidad (Agotado/Disponible)
    socket.on('actualizar-disponibilidad', (datos) => {
        const producto = menuProductos.find(p => p.id === datos.id);
        if (producto) {
            producto.disponible = datos.disponible;
            io.emit('menu-disponibilidad-actualizada', datos);
        }
    });

    // NUEVO: Agregar un plato nuevo al menú diario
    socket.on('agregar-nuevo-producto', (nuevoPlato) => {
        nuevoPlato.id = menuProductos.length > 0 ? Math.max(...menuProductos.map(p => p.id)) + 1 : 1;
        nuevoPlato.disponible = true;
        
        // Agregar a la lista del servidor
        menuProductos.push(nuevoPlato);
        
        // Notificar a todos los clientes en tiempo real para que pinten el nuevo menú
        io.emit('menu-actualizado-completo', menuProductos);
    });

    // NUEVO: Eliminar o limpiar un plato para cambiar el menú al día siguiente
    socket.on('eliminar-producto', (id) => {
        menuProductos = menuProductos.filter(p => p.id !== id);
        io.emit('menu-actualizado-completo', menuProductos);
    });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});