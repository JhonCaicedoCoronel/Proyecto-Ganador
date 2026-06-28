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

    socket.on('verificar-disponibilidad', async (datos) => {
        try {
            const { data: reservasDB } = await supabase.from('reservas').select('*').eq('fecha', datos.fecha).eq('estado', 'activa').eq('sucursal', datos.sucursal);
            const { data: mesasDB } = await supabase.from('mesas').select('*');
            const mesasLibres = (mesasDB || []).filter(m => !reservasDB.map(r => r.mesa_id).includes(m.numero) && m.capacidad >= parseInt(datos.personas));
            
            if (mesasLibres.length > 0) {
                socket.emit('resultado-disponibilidad', { disponible: true, horaExacta: datos.hora, mesa: mesasLibres[0], sucursal: datos.sucursal });
            } else {
                socket.emit('resultado-disponibilidad', { disponible: false, alternativas: [] });
            }
        } catch (err) {
            console.error('Error verificando disponibilidad:', err.message);
        }
    });
};