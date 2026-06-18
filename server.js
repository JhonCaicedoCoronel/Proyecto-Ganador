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

// NUEVO MENÚ BASE CON CANTIDADES DE STOCK (Modifica tu array actual)
let menuProductos = [
    { id: 1, nombre: "Combo Frank's Triple", precio: 11.50, category: "combos", img: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500", stock: 15 },
    { id: 2, nombre: "Combo Hamburguesa Guayaca", precio: 9.00, category: "combos", img: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=500", stock: 8 },
    { id: 3, nombre: "Combo Crispy Chicken", precio: 9.50, category: "combos", img: "https://images.unsplash.com/photo-1625813506062-0aeb1d7a094b?w=500", stock: 12 },
    { id: 4, nombre: "Coca-Cola Personal", precio: 1.50, category: "bebidas", img: "https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500", stock: 30 },
    { id: 5, nombre: "Té Frío de la Casa", precio: 1.75, category: "bebidas", img: "https://images.unsplash.com/photo-1497534446932-c925b458314e?w=500", stock: 20 }
];

io.on('connection', (socket) => {
    // ... mantén tus otros eventos igual ...

    // EVENTO 1: Cuando el administrador edita un plato existente
    socket.on('editar-producto', (productoEditado) => {
        const producto = menuProductos.find(p => p.id === productoEditado.id);
        if (producto) {
            producto.nombre = productoEditado.nombre;
            producto.precio = parseFloat(productoEditado.precio);
            producto.stock = parseInt(productoEditado.stock);
            if(productoEditado.img) producto.img = productoEditado.img;
            
            // Avisar a todos los clientes del cambio de datos y stock
            io.emit('menu-actualizado-completo', menuProductos);
        }
    });

    // EVENTO 2: Descontar stock automáticamente cuando entra un pedido
    socket.on('enviar-pedido', (pedido) => {
        // ... aquí procesas la hora de Ecuador ...

        // Lógica para restar stock (pedido.itemsArray debe procesarse, pero para el MVP
        // el quiosco nos mandará un array ordenado de IDs comprados para restarles stock)
        if (pedido.productosComprados) {
            pedido.productosComprados.forEach(itemComprado => {
                const producto = menuProductos.find(p => p.id === itemComprado.id);
                if (producto) {
                    producto.stock = Math.max(0, producto.stock - itemComprado.cantidad);
                }
            });
            // Notificar a todos el nuevo stock disponible
            io.emit('menu-actualizado-completo', menuProductos);
        }
        
        io.emit('notificar-cocina', pedido);
    });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});