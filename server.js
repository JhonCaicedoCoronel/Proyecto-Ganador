const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir archivos estáticos desde la raíz del proyecto
app.use(express.static(path.join(__dirname)));

// Base de datos simulada de menús por Franquicia / Tenant
const menusPorTenant = {
    'tenant_costenita': [
        { id: 1, nombre: 'Encebollado Mixto', category: 'Platos Fuertes', precio: 5.50, sucursal: 'Todas', img: 'https://images.unsplash.com/photo-1559742811-822873691fc8?w=300', descripcion: 'Tradicional caldo de pescado con camarón.' },
        { id: 2, nombre: 'Ceviche de Camarón', category: 'Ceviches', precio: 7.00, sucursal: 'Todas', img: 'https://images.unsplash.com/photo-1535399831218-d5bd36d1a6b3?w=300', descripcion: 'Camarones frescos con curtido y canguil.' },
        { id: 3, nombre: 'Bolón de Chicharrón', category: 'Desayunos', precio: 3.50, sucursal: 'Todas', img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=300', descripcion: 'Verde majado con chicharrón crujiente y queso.' }
    ],
    'tenant_negroni': [
        { id: 101, nombre: 'Negroni Clásico', category: 'Cocktails', precio: 9.00, sucursal: 'Todas', img: 'https://images.unsplash.com/photo-1514362545857-3bc16c4c7d1b?w=300', descripcion: 'Gin, Campari y Vermouth Rosso.' },
        { id: 102, nombre: 'Pasta Carbonara', category: 'Kitchen', precio: 14.50, sucursal: 'Todas', img: 'https://images.unsplash.com/photo-1612874742237-6526221588e3?w=300', descripcion: 'Pasta italiana con guanciale y pecorino.' },
        { id: 103, nombre: 'Carpaccio de Lomo', category: 'Entradas', precio: 12.00, sucursal: 'Todas', img: 'https://images.unsplash.com/photo-1544025162-d76694265947?w=300', descripcion: 'Finas finas láminas de lomo con alcaparras.' }
    ]
};

// Control de turnos y reservas en memoria por tenant
let reservasActivas = {
    'tenant_costenita': [],
    'tenant_negroni': []
};

io.on('connection', (socket) => {
    let tenantActual = 'tenant_costenita';

    socket.on('unirse-a-restaurante', (tenantId) => {
        tenantActual = tenantId || 'tenant_costenita';
        socket.join(tenantActual);
        
        // Enviar el menú correspondiente al cliente que se conecta
        const menuTenant = menusPorTenant[tenantActual] || menusPorTenant['tenant_costenita'];
        socket.emit('cargar-menu-inicial', menuTenant);
    });

    // Consultar horarios y disponibilidad en tiempo real
    socket.on('consultar-horarios', (data) => {
        const tenant = data.tenant_id || tenantActual;
        // Generador simulado de horarios de disponibilidad
        const horariosBase = [
            { hora: '12:00 PM', disponibles: 4, lleno: false },
            { hora: '01:00 PM', disponibles: 1, lleno: false },
            { hora: '02:00 PM', disponibles: 0, lleno: true },
            { hora: '08:00 PM', disponibles: 3, lleno: false }
        ];
        socket.emit('horarios-para-fecha', horariosBase);
    });

    // Verificar disponibilidad exacta para una mesa
    socket.on('verificar-disponibilidad', (data) => {
        const tenant = data.tenant_id || tenantActual;
        // Simulamos disponibilidad exitosa
        socket.emit('resultado-disponibilidad', {
            disponible: true,
            horaExacta: data.hora,
            sucursal: data.sucursal,
            mesa: Math.floor(Math.random() * 15) + 1
        });
    });

    // Registrar nueva reserva o pedido
    socket.on('enviar-reserva-pedido', (pedido) => {
        const tenant = pedido.tenant_id || tenantActual;
        if (!reservasActivas[tenant]) reservasActivas[tenant] = [];
        
        reservasActivas[tenant].push(pedido);
        
        // Notificar al panel administrativo de la franquicia correspondiente
        io.to(tenant).emit('nuevo-pedido-recibido', pedido);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Book&Bite corriendo en el puerto ${PORT}`);
});