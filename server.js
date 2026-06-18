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

// Base de datos en memoria con stock real controlado por porciones
let menuProductos = [
    { id: 1, nombre: "Combo Frank's Triple", precio: 11.50, category: "combos", img: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500", stock: 15 },
    { id: 2, nombre: "Combo Hamburguesa Guayaca", precio: 9.00, category: "combos", img: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=500", stock: 8 },
    { id: 3, nombre: "Combo Crispy Chicken", precio: 9.50, category: "combos", img: "https://images.unsplash.com/photo-1625813506062-0aeb1d7a094b?w=500", stock: 12 },
    { id: 4, nombre: "Coca-Cola Personal", precio: 1.50, category: "bebidas", img: "https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500", stock: 30 },
    { id: 5, nombre: "Té Frío de la Casa", precio: 1.75, category: "bebidas", img: "https://images.unsplash.com/photo-1497534446932-c925b458314e?w=500", stock: 20 }
];

io.on('connection', (socket) => {
    console.log('📱 Dispositivo conectado al sistema: ' + socket.id);

    // Enviar el estado actual del menú al conectar cualquier pantalla
    socket.emit('cargar-menu-inicial', menuProductos);

    // EVENTO 1: Procesar Pedido Real (Desde Quiosco Físico o Caja)
    socket.on('enviar-pedido', (pedido) => {
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        pedido.esFantasma = false; // Pedido real inmediato
        
        // Descontar inventario físico
        if (pedido.productosComprados) {
            pedido.productosComprados.forEach(itemComprado => {
                const producto = menuProductos.find(p => p.id === itemComprado.id);
                if (producto) {
                    producto.stock = Math.max(0, producto.stock - itemComprado.cantidad);
                }
            });
            io.emit('menu-actualizado-completo', menuProductos);
        }
        io.emit('notificar-cocina', pedido);
    });

    // EVENTO 2: Procesar Pedido Fantasma (Pre-orden Remota desde la calle)
    socket.on('enviar-preorden-fantasma', (pedido) => {
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        
        // Calcular hora estimada de arribo al local basándose en los minutos de retraso informados
        let horaLlegada = new Date();
        const minutosEspera = parseInt(pedido.minutosEstimados) || 10;
        horaLlegada.setMinutes(horaLlegada.getMinutes() + minutosEspera);
        
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        pedido.horaLlegadaEstimada = horaLlegada.toLocaleTimeString('en-US', opciones);
        pedido.esFantasma = true; // Flag de diseño KDS

        // El pedido fantasma descuenta porciones preventivamente para asegurar el plato
        if (pedido.productosComprados) {
            pedido.productosComprados.forEach(itemComprado => {
                const producto = menuProductos.find(p => p.id === itemComprado.id);
                if (producto) {
                    producto.stock = Math.max(0, producto.stock - itemComprado.cantidad);
                }
            });
            io.emit('menu-actualizado-completo', menuProductos);
        }
        io.emit('notificar-cocina', pedido);
    });

    // EVENTO 3: Modificar plato o reabastecer porciones desde Panel Admin
    socket.on('editar-producto', (productoEditado) => {
        const producto = menuProductos.find(p => p.id === productoEditado.id);
        if (producto) {
            producto.nombre = productoEditado.nombre;
            producto.precio = parseFloat(productoEditado.precio);
            producto.stock = parseInt(productoEditado.stock);
            if(productoEditado.img) producto.img = productoEditado.img;
            
            io.emit('menu-actualizado-completo', menuProductos);
        }
    });

    // EVENTO 4: Agregar nuevo ítem al menú del día
    socket.on('agregar-nuevo-producto', (nuevoPlato) => {
        nuevoPlato.id = menuProductos.length > 0 ? Math.max(...menuProductos.map(p => p.id)) + 1 : 1;
        nuevoPlato.stock = parseInt(nuevoPlato.stock) || 0;
        menuProductos.push(nuevoPlato);
        io.emit('menu-actualizado-completo', menuProductos);
    });

    // EVENTO 5: Quitar producto
    socket.on('eliminar-producto', (id) => {
        menuProductos = menuProductos.filter(p => p.id !== id);
        io.emit('menu-actualizado-completo', menuProductos);
    });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => {
    console.log(`🚀 Servidor de Frank's Burgers corriendo en puerto ${PORT}`);
});