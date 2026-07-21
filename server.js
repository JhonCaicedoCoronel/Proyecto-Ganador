const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// Servir archivos estáticos desde la carpeta public y la raíz
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// --- RUTA RAÍZ ---
app.get('/', (req, res) => { 
    res.sendFile(path.join(__dirname, 'public', 'index.html')); 
});

// Base de datos robusta en memoria estructurada por franquicias (Multi-tenant)
const tenantsData = {
    'tenant_costenita': {
        nombre: 'La Costeñita',
        menu: [
            { id: 1, nombre: 'Encebollado Mixto', precio: 4.50, category: 'Encebollados', descripcion: 'Con albacora y camarón fresco.', img: 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500', sucursal: 'Todas' },
            { id: 2, nombre: 'Bolón de Chicharrón', precio: 3.50, category: 'Bolones', descripcion: 'Verde majado con chicharrón crujiente y queso.', img: 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=500', sucursal: 'Todas' },
            { id: 3, nombre: 'Seco de Gallina', precio: 5.00, category: 'Secos', descripcion: 'Gallina criolla con maduro frito y arroz.', img: 'https://images.unsplash.com/photo-1555939594-58d7cb561ad1?w=500', sucursal: 'Urdesa' }
        ],
        mesas: [
            { numero: 1, capacidad: 4, ubicacion: 'Salón Principal', estado: 'disponible' },
            { numero: 2, capacidad: 2, ubicacion: 'Ventana', estado: 'disponible' },
            { numero: 3, capacidad: 6, ubicacion: 'Terraza', estado: 'disponible' },
            { numero: 4, capacidad: 4, ubicacion: 'Salón Principal', estado: 'disponible' }
        ],
        reservas: [],
        pedidosCocina: [],
        historialVentas: []
    },
    'tenant_negroni': {
        nombre: 'Negroni',
        menu: [
            { id: 101, nombre: 'Negroni Clásico', precio: 8.50, category: 'Bebidas', descripcion: 'Gin, Campari y Vermouth rosso.', img: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?w=500', sucursal: 'Todas' },
            { id: 102, nombre: 'Pasta Carbonara', precio: 12.00, category: 'Para Compartir', descripcion: 'Pancetta crujiente y pecorino romano.', img: 'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=500', sucursal: 'Todas' }
        ],
        mesas: [
            { numero: 1, capacidad: 2, ubicacion: 'Barra', estado: 'disponible' },
            { numero: 2, capacidad: 4, ubicacion: 'Salón VIP', estado: 'disponible' }
        ],
        reservas: [],
        pedidosCocina: [],
        historialVentas: []
    }
};

io.on('connection', (socket) => {
    let currentTenant = 'tenant_costenita';

    // Unirse a la sala de la franquicia correspondiente
    socket.on('unirse-a-restaurante', (tenantId) => {
        const tid = tenantId || 'tenant_costenita';
        if (tenantsData[tid]) {
            currentTenant = tid;
            socket.join(tid);
            
            // Enviar datos sincronizados de inmediato para evitar pantallas vacías o datos borrados
            socket.emit('cargar-menu-inicial', tenantsData[tid].menu);
            socket.emit('cargar-mesas-inicial', tenantsData[tid].mesas);
            socket.emit('cargar-pedidos-cocina', tenantsData[tid].pedidosCocina);
            socket.emit('cargar-historial', tenantsData[tid].historialVentas);
            socket.emit('cargar-historial-reservas', tenantsData[tid].reservas);
        }
    });

    // Gestión de Menú (Editor)
    socket.on('agregar-nuevo-producto', (prod) => {
        const store = tenantsData[currentTenant];
        if (!store) return;
        prod.id = Date.now();
        store.menu.push(prod);
        io.to(currentTenant).emit('menu-actualizado-completo', store.menu);
    });

    socket.on('editar-producto', (prodEditado) => {
        const store = tenantsData[currentTenant];
        if (!store) return;
        store.menu = store.menu.map(p => p.id === prodEditado.id ? prodEditado : p);
        io.to(currentTenant).emit('menu-actualizado-completo', store.menu);
    });

    socket.on('eliminar-producto', (id) => {
        const store = tenantsData[currentTenant];
        if (!store) return;
        store.menu = store.menu.filter(p => p.id !== id);
        io.to(currentTenant).emit('menu-actualizado-completo', store.menu);
    });

    // Estado de Mesas
    socket.on('cambiar-estado-mesa', ({ numero, estado }) => {
        const store = tenantsData[currentTenant];
        if (!store) return;
        const mesa = store.mesas.find(m => m.numero === numero);
        if (mesa) {
            mesa.estado = estado;
            io.to(currentTenant).emit('mesas-actualizadas', store.mesas);
        }
    });

    // Horarios y Disponibilidad
    socket.on('consultar-horarios', ({ fecha, personas, sucursal, tenant_id }) => {
        const store = tenantsData[tenant_id || currentTenant];
        if (!store) return;
        const horasBase = ['12:30', '13:00', '13:30', '14:00', '19:00', '19:30', '20:00', '20:30'];
        const horariosRespuesta = horasBase.map(h => {
            const ocupadas = store.reservas.filter(r => r.fecha === fecha && r.hora === h && r.sucursal === sucursal).length;
            const disponibles = Math.max(0, store.mesas.length - ocupadas);
            return { hora: h, disponibles, lleno: disponibles === 0 };
        });
        socket.emit('horarios-para-fecha', horariosRespuesta);
    });

    socket.on('verificar-disponibilidad', ({ fecha, hora, personas, sucursal, tenant_id }) => {
        const store = tenantsData[tenant_id || currentTenant];
        if (!store) return;
        const mesaLibre = store.mesas.find(m => m.estado === 'disponible');
        socket.emit('resultado-disponibilidad', {
            disponible: true,
            horaExacta: hora,
            sucursal: sucursal,
            mesa: mesaLibre || store.mesas[0]
        });
    });

    // GENERACIÓN DE TURNOS Y RESERVAS (Solución al problema principal)
    socket.on('enviar-reserva-pedido', (pedido) => {
        const tenantKey = pedido.tenant_id || currentTenant;
        const store = tenantsData[tenantKey];
        if (!store) return;

        const sucursal = pedido.datosReserva ? pedido.datosReserva.sucursal : 'Urdesa';
        const reservasActivas = store.reservas.filter(r => r.sucursal === sucursal && (r.estado === 'activa' || !r.estado));
        const turnoFila = reservasActivas.length + 1;

        pedido.id = pedido.id || Date.now();
        pedido.turnoFila = turnoFila;
        pedido.turno_sala = turnoFila;
        pedido.estado = 'activa';
        pedido.sucursal = sucursal;
        pedido.mesa_id = pedido.datosReserva && pedido.datosReserva.mesa ? pedido.datosReserva.mesa.numero : 1;
        pedido.cliente = pedido.datosReserva ? pedido.datosReserva.nombre : 'Cliente Invitado';
        pedido.fecha = pedido.datosReserva ? pedido.datosReserva.fecha : new Date().toISOString().split('T')[0];
        pedido.hora = pedido.datosReserva ? pedido.datosReserva.hora : '13:00';
        pedido.personas = pedido.datosReserva ? pedido.datosReserva.personas : 2;
        pedido.item = pedido.item || (pedido.productosComprados ? pedido.productosComprados.map(i => `${i.cantidad}x ${i.nombre}`).join(', ') : 'Reserva de Mesa');
        pedido.pago = pedido.pago || 'Tarjeta';

        store.reservas.push(pedido);
        store.pedidosCocina.push(pedido);

        // Emitir actualizaciones en tiempo real a todas las pantallas conectadas del tenant
        io.to(tenantKey).emit('notificar-cocina', pedido);
        io.to(tenantKey).emit('cargar-pedidos-cocina', store.pedidosCocina);
        io.to(tenantKey).emit('cargar-historial-reservas', store.reservas);
    });

    // Historiales y Carga de Datos
    socket.on('obtener-historial-reservas', (tenantId) => {
        const store = tenantsData[tenantId || currentTenant];
        if (store) socket.emit('cargar-historial-reservas', store.reservas);
    });

    socket.on('obtener-historial-dia', (tenantId) => {
        const store = tenantsData[tenantId || currentTenant];
        if (store) socket.emit('cargar-historial', store.historialVentas);
    });

    socket.on('obtener-pedidos-cocina', (tenantId) => {
        const store = tenantsData[tenantId || currentTenant];
        if (store) socket.emit('cargar-pedidos-cocina', store.pedidosCocina);
    });

    // Despacho de Cocina (Pase automático al Historial de Ventas)
    socket.on('pedido-despachado-cocina', (idPedido) => {
        const store = tenantsData[currentTenant];
        if (!store) return;
        const index = store.pedidosCocina.findIndex(p => p.id === idPedido);
        if (index !== -1) {
            const pedidoCompletado = store.pedidosCocina.splice(index, 1)[0];
            pedidoCompletado.estado = 'completado';
            store.historialVentas.push(pedidoCompletado);

            io.to(currentTenant).emit('cargar-pedidos-cocina', store.pedidosCocina);
            io.to(currentTenant).emit('cargar-historial', store.historialVentas);
        }
    });

    // Salida de mesa y reordenamiento de turnos
    socket.on('marcar-salida-reserva', ({ id, mesa_id, tenant_id }) => {
        const store = tenantsData[tenant_id || currentTenant];
        if (!store) return;
        const reserva = store.reservas.find(r => r.id === id);
        if (reserva) {
            reserva.estado = 'finalizada';
            reserva.hora_salida = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            let turnoContador = 1;
            store.reservas.forEach(r => {
                if (r.sucursal === reserva.sucursal && r.estado === 'activa') {
                    r.turno_sala = turnoContador;
                    r.turnoFila = turnoContador;
                    turnoContador++;
                }
            });

            io.to(tenant_id || currentTenant).emit('cargar-historial-reservas', store.reservas);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Book&Bite corriendo al 100% en el puerto ${PORT}`);
});