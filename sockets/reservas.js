// sockets/reservas.js
const path = require('path');
const supabase = require(path.join(__dirname, '../db'));

module.exports = (io, socket) => {
    socket.on('consultar-horarios', async (datos) => {
        try {
            const personasRequeridas = parseInt(datos.personas) || 1;
            const { data: reservasDB } = await supabase.from('reservas').select('*')
                .eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
            const { data: mesasDB } = await supabase.from('mesas').select('*');
            
            const horariosDisponibles = ["12:00", "13:00", "14:00", "15:00", "18:00", "19:00", "20:00", "21:00"];
            const horariosEstado = horariosDisponibles.map(hora => {
                const reservasTurno = (reservasDB || []).filter(r => r.hora === hora);
                const mesasOcupadasIds = reservasTurno.map(r => r.mesa_id);
                const mesasAptas = (mesasDB || []).filter(m => !mesasOcupadasIds.includes(m.numero) && m.capacidad >= personasRequeridas);
                return { hora: hora, lleno: mesasAptas.length === 0, disponibles: mesasAptas.length };
            });
            
            socket.emit('horarios-para-fecha', horariosEstado);
        } catch (err) {
            console.error('Error en consulta de horarios:', err.message);
        }
    });

    socket.on('marcar-salida-reserva', async (datos) => {
        try {
            const { data: resSale } = await supabase.from('reservas').select('*').eq('id', datos.id).single();
            if (!resSale) return;

            const horaActual = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Guayaquil', hour: '2-digit', minute: '2-digit', hour12: true });

            await supabase.from('reservas').update({ estado: 'finalizada', hora_salida: horaActual }).eq('id', datos.id);
            await supabase.from('mesas').update({ estado: 'sucia' }).eq('numero', datos.mesa_id);

            const { data: reservasAfectadas } = await supabase.from('reservas').select('*')
                .eq('sucursal', resSale.sucursal).eq('fecha', resSale.fecha).eq('hora', resSale.hora)
                .eq('estado', 'activa').gt('turno_sala', resSale.turno_sala);

            if (reservasAfectadas) {
                for (const r of reservasAfectadas) {
                    const nuevoTurno = r.turno_sala - 1;
                    await supabase.from('reservas').update({ turno_sala: nuevoTurno }).eq('id', r.id);
                    io.emit('notificacion-avance-turno', { idReserva: r.id, nuevoTurno: nuevoTurno });
                }
            }
            const { data: nuevasMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
            io.emit('mesas-actualizadas', nuevasMesas);
        } catch (err) {
            console.error('Error al marcar salida:', err.message);
        }
    });
};