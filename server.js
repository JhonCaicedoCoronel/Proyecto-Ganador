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
    { numero: 3, capacidad: 4, ubicacion: "Ventana", estado: "disponible" },
    { numero: 4, capacidad: 6, ubicacion: "Interior", estado: "disponible" }
];

// 3. BASE DE DATOS DE CLIENTES (Fidelización, Alergias y Encuestas)
let baseDatosClientes = [];

io.on('connection', (socket) => {
    // Envíos iniciales
    socket.emit('cargar-menu-inicial', menuProductos);
    socket.emit('cargar-mesas-inicial', estadoMesas);

    // RECEPCIÓN DE ÓRDENES (Manejo estricto de las reglas solicitadas)
    socket.on('enviar-pedido', (pedido) => {
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        
        // Regla de Pago e Indicadores para la cocina
        if (pedido.tipo === 'Pre-orden Remota 👻') {
            pedido.esFantasma = true;
            let horaArribo = new Date();
            horaArribo.setMinutes(horaArribo.getMinutes() + (parseInt(pedido.minutosEstimados) || 15));
            pedido.horaLlegadaEstimada = horaArribo.toLocaleTimeString('en-US', opciones);
            
            // Si es remoto: Tarjeta = Procesando / Efectivo = Pendiente
            pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Procesando Pre-orden ⏳" : "Pendiente de Pago (Remoto) ⚠️";
        } else {
            // Si ya está en el lugar (Físico)
            pedido.esFantasma = false;
            pedido.horaLlegadaEstimada = "Ya en el local";
            // Si está en el local: Tarjeta = Pedido Pagado / Efectivo = Pendiente Pago
            pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Pedido Pagado (En Local) ✅" : "Pedido Pendiente Pago (En Caja) 💵";
        }

        // Restar Stock
        if (pedido.productosComprados) {
            pedido.productosComprados.forEach(item => {
                const p = menuProductos.find(prod => prod.id === item.id);
                if (p) p.stock = Math.max(0, p.stock - item.cantidad);
            });
            io.emit('menu-actualizado-completo', menuProductos);
        }

        // Si el cliente completó la encuesta de perfil, la guardamos en la base de datos
        if (pedido.perfilCliente) {
            baseDatosClientes.push({
                fecha: new Date().toLocaleDateString(),
                ...pedido.perfilCliente,
                pedidoId: pedido.id
            });
            console.log("📊 Nuevo cliente registrado en la Base de Datos:", pedido.perfilCliente);
        }

        io.emit('notificar-cocina', pedido);
    });

    // Despachar pedido manual de cocina
    socket.on('pedido-despachado-cocina', (id) => { io.emit('pedido-listo-retirar', id); });

    // Gestión de mesas desde modulo de sala
    socket.on('cambiar-estado-mesa', (datos) => {
        const mesa = estadoMesas.find(m => m.numero === datos.numero);
        if (mesa) { mesa.estado = datos.estado; io.emit('mesas-actualizadas', estadoMesas); }
    });

    // CRUD MENÚ
    socket.on('agregar-nuevo-producto', (p) => { p.id = Date.now(); menuProductos.push(p); io.emit('menu-actualizado-completo', menuProductos); });
    socket.on('editar-producto', (p) => {
        const prod = menuProductos.find(m => m.id === p.id);
        if (prod) { Object.assign(prod, p); io.emit('menu-actualizado-completo', menuProductos); }
    });
    socket.on('eliminar-producto', (id) => { menuProductos = menuProductos.filter(p => p.id !== id); io.emit('menu-actualizado-completo', menuProductos); });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 SaaS corriendo en puerto ${PORT}`));