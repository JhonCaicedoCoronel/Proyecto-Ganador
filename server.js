const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname)));

// Base de datos en memoria estructurada por Tenant (Franquicias)
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

    // Unirse a la sala del restaurante correspondiente
    socket.on('unirse-a-restaurante', (tenantId) => {
        if (tenantsData[tenantId]) {
            currentTenant = tenantId;
            socket.join(tenantId);
            
            // Enviar datos iniciales al cliente para evitar pantallas vacías al recargar
            socket.emit('cargar-menu-inicial', tenantsData[tenantId].menu);
            socket.emit('cargar-mesas-inicial', tenantsData[tenantId].mesas);
            socket.emit('cargar-pedidos-cocina', tenantsData[tenantId].pedidosCocina);
            socket.emit('cargar-historial', tenantsData[tenantId].historialVentas);
            socket.emit('cargar-historial-reservas', tenantsData[tenantId].reservas);
        }
    });

    // Gestión de Menú
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

    // Gestión de Mesas
    socket.on('cambiar-estado-mesa', ({ numero, estado }) => {
        const store = tenantsData[currentTenant];
        if (!store) return;
        const mesa = store.mesas.find(m => m.numero === numero);
        if (mesa) {
            mesa.estado = estado;
            io.to(currentTenant).emit('mesas-actualizadas', store.mesas);
        }
    });

    // Verificación de disponibilidad y horarios
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
        const ocupadas = store.reservas.filter(r => r.fecha === fecha && r.hora === hora && r.sucursal === sucursal).length;
        
        if (ocupadas < store.mesas.length) {
            socket.emit('resultado-disponibilidad', {
                disponible: true,
                horaExacta: hora,
                sucursal: sucursal,
                mesa: mesaLibre || store.mesas[0]
            });
        } else {
            socket.emit('resultado-disponibilidad', {
                disponible: false,
                alternativas: ['14:30', '21:00']
            });
        }
    });

    // Envío de Reservas y Pedidos (Generación de Turnos automática)
    socket.on('enviar-reserva-pedido', (pedido) => {
        const store = tenantsData[pedido.tenant_id || currentTenant];
        if (!store) return;

        const sucursal = pedido.datosReserva ? pedido.datosReserva.sucursal : 'Urdesa';
        const reservasActivas = store.reservas.filter(r => r.sucursal === sucursal && (r.estado === 'activa' || !r.estado));
        const turnoFila = reservasActivas.length + 1;

        pedido.turnoFila = turnoFila;
        pedido.turno_sala = turnoFila;
        pedido.estado = 'activa';
        pedido.sucursal = sucursal;
        pedido.mesa_id = pedido.datosReserva && pedido.datosReserva.mesa ? pedido.datosReserva.mesa.numero : 1;

        store.reservas.push(pedido);
        
        // Si el pedido tiene platos, agregarlo a la cocina
        if (pedido.productosComprados && pedido.productosComprados.length > 0 || pedido.item !== "Mesa Reservada (Sin pedido)") {
            store.pedidosCocina.push(pedido);
            io.to(pedido.tenant_id || currentTenant).emit('notificar-cocina', pedido);
        }

        io.to(pedido.tenant_id || currentTenant).emit('cargar-historial-reservas', store.reservas);
    });

    // Obtener historiales
    socket.on('obtener-historial-reservas', (tenantId) => {
        const store = tenantsData[tenantId || currentTenant];
        if (store) socket.emit('cargar-historial-reservas', store.reservas);
    });

    socket.on('obtener-historial-dia', (tenantId) => {
        const store = tenantsData[tenantId || currentTenant];
        if (store) socket.emit('cargar-historial', store.historialVentas);
    });

    socket.on('obtener-pedidos-cocina', () => {
        const store = tenantsData[currentTenant];
        if (store) socket.emit('cargar-pedidos-cocina', store.pedidosCocina);
    });

    // Despacho de cocina y pase al historial de ventas
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

    // Marcar salida de reserva / mesa
    socket.on('marcar-salida-reserva', ({ id, mesa_id, tenant_id }) => {
        const store = tenantsData[tenant_id || currentTenant];
        if (!store) return;
        const reserva = store.reservas.find(r => r.id === id);
        if (reserva) {
            reserva.estado = 'finalizada';
            reserva.hora_salida = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

            // Reordenar turnos activos restantes de la misma sucursal
            let turnoContador = 1;
            store.reservas.forEach(r => {
                if (r.sucursal === reserva.sucursal && r.estado === 'activa') {
                    r.turno_sala = turnoContador;
                    r.turnoFila = turnoContador;
                    turnoContador++;
                    io.to(tenant_id || currentTenant).emit('notificacion-avance-turno', { idReserva: r.id, nuevoTurno: r.turno_sala });
                }
            });

            io.to(tenant_id || currentTenant).emit('cargar-historial-reservas', store.reservas);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Servidor de Book&Bite corriendo exitosamente en el puerto ${PORT}`);
});