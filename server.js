const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('public'));

app.get('/', (req, res) => { res.redirect('/quiosco.html'); });

// 1. MENÚ DINÁMICO
let menuProductos = [
    { id: 1, nombre: "Combo Frank's Triple", precio: 11.50, category: "combos", img: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500", stock: 15 },
    { id: 2, nombre: "Combo Hamburguesa Guayaca", precio: 9.00, category: "combos", img: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=500", stock: 8 },
    { id: 4, nombre: "Coca-Cola Personal", precio: 1.50, category: "bebidas", img: "https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500", stock: 30 }
];

// 2. MESAS CON UBICACIÓN
let estadoMesas = [
    { numero: 1, capacidad: 2, ubicacion: "Interior", estado: "disponible" },
    { numero: 2, capacidad: 4, ubicacion: "Terraza", estado: "disponible" },
    { numero: 3, capacity: 4, ubicacion: "Ventana", estado: "disponible" }
];

let baseDatosClientes = [];
let contadorTurnos = 1; // Fila virtual global

io.on('connection', (socket) => {
    socket.emit('cargar-menu-inicial', menuProductos);
    socket.emit('cargar-mesas-inicial', estadoMesas);

    // CANAL UNIFICADO: Recibe pedidos normales y físicos
    socket.on('enviar-pedido', (pedido) => {
        pedido.turnoFila = contadorTurnos++;
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        pedido.esFantasma = false;
        pedido.horaLlegadaEstimada = "Ya en el local";
        pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Pedido Pagado (En Local) ✅" : "Pedido Pendiente Pago (En Caja) 💵";

        descontarStock(pedido.productosComprados);
        
        // Confirmar turno de regreso al cliente que ordenó
        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        // Enviar a la pantalla de cocina por el canal correcto
        io.emit('notificar-cocina', pedido);
    });

    // CORRECCIÓN CANAL FANTASMA: Ahora dispara la alerta al KDS sin pérdidas
    socket.on('enviar-preorden-fantasma', (pedido) => {
        pedido.turnoFila = contadorTurnos++;
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        
        let horaArribo = new Date();
        horaArribo.setMinutes(horaArribo.getMinutes() + (parseInt(pedido.minutosEstimados) || 15));
        
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        pedido.horaLlegadaEstimada = horaArribo.toLocaleTimeString('en-US', opciones);
        pedido.esFantasma = true;
        pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Procesando Pre-orden ⏳" : "Pendiente de Pago (Remoto) ⚠️";

        descontarStock(pedido.productosComprados);

        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        // Inyección directa y corregida en la pantalla de cocina
        io.emit('notificar-cocina', pedido);
    });

    // Registrar datos de la encuesta opcional post-venta
    socket.on('guardar-encuesta-opcional', (datosEncuesta) => {
        baseDatosClientes.push({
            fecha: new Date().toLocaleDateString(),
            ...datosEncuesta
        });
        console.log("📊 Encuesta opcional guardada en la base de datos:", datosEncuesta);
    });

    socket.on('pedido-despachado-cocina', (id) => { io.emit('pedido-listo-retirar', id); });
    socket.on('cambiar-estado-mesa', (datos) => {
        const mesa = estadoMesas.find(m => m.numero === datos.numero);
        if (mesa) { mesa.estado = datos.estado; io.emit('mesas-actualizadas', estadoMesas); }
    });

    function descontarStock(productosComprados) {
        if (productosComprados) {
            productosComprados.forEach(item => {
                const p = menuProductos.find(prod => prod.id === item.id);
                if (p) p.stock = Math.max(0, p.stock - item.cantidad);
            });
            io.emit('menu-actualizado-completo', menuProductos);
        }
    }

    // CRUD MENÚ
    socket.on('agregar-nuevo-producto', (p) => { p.id = Date.now(); menuProductos.push(p); io.emit('menu-actualizado-completo', menuProductos); });
    socket.on('editar-producto', (p) => {
        const prod = menuProductos.find(m => m.id === p.id);
        if (prod) { Object.assign(prod, p); io.emit('menu-actualizado-completo', menuProductos); }
    });
    socket.on('eliminar-producto', (id) => { menuProductos = menuProductos.filter(p => p.id !== id); io.emit('menu-actualizado-completo', menuProductos); });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 SaaS centralizado corriendo en puerto ${PORT}`));