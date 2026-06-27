require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Conexión blindada a Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(express.static('public'));

// Generador de Turnos tipo Hospital
let contadoresTurno = { Urdesa: 1, Samborondon: 1, Sur: 1 };

function generarTurnoHospital(sucursal) {
    let prefijo = 'U'; // Urdesa
    if (sucursal === 'Samborondon') prefijo = 'A'; // sAmborondon
    if (sucursal === 'Sur') prefijo = 'S'; // Sur
    
    let numero = contadoresTurno[sucursal]++;
    // Genera formato: U-001, S-005, etc.
    return `${prefijo}-${numero.toString().padStart(3, '0')}`;
}

io.on('connection', (socket) => {
    console.log('Nueva conexión entrante:', socket.id);

    // 1. Enviar Menú
    socket.on('pedir-menu', async () => {
        const { data } = await supabase.from('menu').select('*');
        socket.emit('actualizar-menu', data || []);
    });

    // 2. Lógica Inteligente de Disponibilidad de Mesas
    socket.on('consultar-disponibilidad', async (datos) => {
        // Buscamos mesas en esa sucursal que tengan la capacidad requerida
        const { data: mesasFisicas } = await supabase.from('mesas')
            .select('*')
            .eq('sucursal', datos.sucursal)
            .gte('capacidad', datos.personas);

        // Buscamos si ya hay reservas para ese día y hora
        const { data: reservasExistentes } = await supabase.from('reservas')
            .select('mesa_id')
            .eq('fecha', datos.fecha)
            .eq('hora', datos.hora)
            .eq('sucursal', datos.sucursal);

        let mesasOcupadasIds = reservasExistentes ? reservasExistentes.map(r => r.mesa_id) : [];
        
        // Filtramos las mesas físicas quitando las que ya están reservadas
        let mesasDisponibles = (mesasFisicas || []).filter(m => !mesasOcupadasIds.includes(m.id));
        
        socket.emit('respuesta-disponibilidad', mesasDisponibles);
    });

    // 3. Recibir Nuevo Pedido / Pre-orden y Generar Turno
    socket.on('nuevo-pedido', async (pedido) => {
        // Asignar el turno tipo hospital
        const turnoGenerado = generarTurnoHospital(pedido.reserva.sucursal);
        pedido.turno = turnoGenerado;

        // Si hay una mesa asignada, guardamos la reserva y cambiamos el estado de la mesa
        if (pedido.reserva.mesa_id) {
            await supabase.from('reservas').insert([{
                cliente: pedido.cliente,
                sucursal: pedido.reserva.sucursal,
                fecha: pedido.reserva.fecha,
                hora: pedido.reserva.hora,
                mesa_id: pedido.reserva.mesa_id,
                turno: turnoGenerado,
                estado: 'Confirmada'
            }]);

            await supabase.from('mesas').update({ estado: 'Reservada' }).eq('id', pedido.reserva.mesa_id);
            io.emit('actualizar-monitor-mesas'); // Avisa al panel de mesas al instante
        }

        // Si el cliente hizo pre-orden, va a la cocina
        if (pedido.items && pedido.items.length > 0) {
            await supabase.from('pedidos_cocina').insert([{
                cliente: pedido.cliente,
                sucursal: pedido.reserva.sucursal,
                turno: turnoGenerado,
                items: JSON.stringify(pedido.items),
                total: pedido.total,
                estado: 'Pendiente',
                mesa_id: pedido.reserva.mesa_id || null
            }]);
            io.emit('notificar-cocina'); // Avisa a los chefs
        }

        // Le devolvemos el turno al cliente para su ticket
        socket.emit('pedido-confirmado', turnoGenerado);
    });

    // 4. Gestión del Monitor de Mesas
    socket.on('pedir-monitor-mesas', async () => {
        const { data } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
        socket.emit('renderizar-mesas', data || []);
    });

    // 5. Cocina Despacha (Actualiza Turno Hospital)
    socket.on('despachar-pedido', async (id, turno) => {
        await supabase.from('pedidos_cocina').update({ estado: 'Entregado' }).eq('id', id);
        io.emit('notificar-cocina');
        
        // ¡Magia! Dispara la alerta en las pantallas y celulares de que el turno está listo
        io.emit('turno-listo-hospital', turno); 
    });
});

const PORT = process.env.PORT || 3090;
server.listen(PORT, () => console.log(`Servidor de La Costeñita corriendo en puerto ${PORT}`));