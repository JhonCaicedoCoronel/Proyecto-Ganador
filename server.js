const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

app.use(express.static('public'));

app.get('/', (req, res) => { res.redirect('/quiosco.html'); });

// --- 1. BASE DE DATOS EN MEMORIA ---
let menuProductos = [
    { id: 1, nombre: "Combo J&J Triple", precio: 11.50, category: "combos", img: "https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=500", stock: 15 },
    { id: 2, nombre: "Combo Hamburguesa Guayaca", precio: 9.00, category: "combos", img: "https://images.unsplash.com/photo-1594212699903-ec8a3eca50f5?w=500", stock: 8 },
    { id: 4, nombre: "Coca-Cola Personal", precio: 1.50, category: "bebidas", img: "https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=500", stock: 30 }
];

let estadoMesas = [
    { numero: 1, capacidad: 2, ubicacion: "Interior", estado: "disponible" },
    { numero: 2, capacidad: 4, ubicacion: "Terraza", estado: "disponible" },
    { numero: 3, capacidad: 4, ubicacion: "Ventana", estado: "disponible" },
    { numero: 4, capacidad: 6, ubicacion: "Interior", estado: "disponible" }
];

let reservasGlobales = []; 
let contadorTurnos = 1;
const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];

io.on('connection', (socket) => {
    socket.emit('cargar-menu-inicial', menuProductos);
    socket.emit('cargar-mesas-inicial', estadoMesas);

    // --- MOTOR DE RESERVAS ---
    socket.on('verificar-disponibilidad', (datos) => {
        const reservasEnEseTurno = reservasGlobales.filter(r => r.fecha === datos.fecha && r.hora === datos.hora);
        
        if (reservasEnEseTurno.length < estadoMesas.length) {
            socket.emit('resultado-disponibilidad', { disponible: true, horaExacta: datos.hora });
        } else {
            let alternativas = horariosDisponibles.filter(h => {
                return reservasGlobales.filter(r => r.fecha === datos.fecha && r.hora === h).length < estadoMesas.length;
            });
            socket.emit('resultado-disponibilidad', { disponible: false, alternativas: alternativas.slice(0, 3) });
        }
    });

    // --- PROCESAMIENTO DE ORDEN Y RESERVA ---
    socket.on('enviar-reserva-pedido', (pedido) => {
        pedido.turnoFila = contadorTurnos++;
        const opciones = { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true };
        pedido.horaRegistro = new Date().toLocaleTimeString('en-US', opciones);
        
        reservasGlobales.push({
            id: pedido.id,
            cliente: pedido.cliente,
            fecha: pedido.datosReserva.fecha,
            hora: pedido.datosReserva.hora,
            personas: pedido.datosReserva.personas
        });

        pedido.esFantasma = true; 
        pedido.horaLlegadaEstimada = `${pedido.datosReserva.fecha} a las ${pedido.datosReserva.hora}`;
        pedido.estadoCocinaTexto = (pedido.pago === 'Tarjeta') ? "Reserva Pagada Web ✅" : "Reserva Pendiente Pago 💵";

        if (pedido.productosComprados) {
            pedido.productosComprados.forEach(item => {
                const p = menuProductos.find(prod => prod.id === item.id);
                if (p) p.stock = Math.max(0, p.stock - item.cantidad);
            });
            io.emit('menu-actualizado-completo', menuProductos);
        }

        socket.emit('confirmacion-turno-cliente', { turno: pedido.turnoFila });
        io.emit('notificar-cocina', pedido);
    });

    // --- GESTIÓN DE SALA Y COCINA ---
    socket.on('pedido-despachado-cocina', (id) => { io.emit('pedido-listo-retirar', id); });
    socket.on('cambiar-estado-mesa', (datos) => {
        const mesa = estadoMesas.find(m => m.numero === datos.numero);
        if (mesa) { mesa.estado = datos.estado; io.emit('mesas-actualizadas', estadoMesas); }
    });

    // --- CRUD MENÚ ADMIN ---
    socket.on('agregar-nuevo-producto', (p) => { p.id = Date.now(); menuProductos.push(p); io.emit('menu-actualizado-completo', menuProductos); });
    socket.on('editar-producto', (p) => {
        const prod = menuProductos.find(m => m.id === p.id);
        if (prod) { Object.assign(prod, p); io.emit('menu-actualizado-completo', menuProductos); }
    });
    socket.on('eliminar-producto', (id) => { menuProductos = menuProductos.filter(p => p.id !== id); io.emit('menu-actualizado-completo', menuProductos); });
});

const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Motor J&J corriendo en el puerto ${PORT}`));