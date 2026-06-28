// cocina.js
const supabase = require('./db');

module.exports = (io, socket) => {
    // Escucha para obtener pedidos pendientes
    socket.on('obtener-pedidos-cocina', async () => {
        try {
            const { data: pedidosDB, error } = await supabase
                .from('pedidos_cocina')
                .select('*')
                .eq('estado', 'pendiente')
                .order('id', { ascending: true });
            
            if (error) throw error;

            const pedidosPendientes = (pedidosDB || []).map(p => ({
                id: p.id, cliente: p.cliente, item: p.item, pago: p.pago, tipo: p.tipo,
                turnoFila: p.turno_fila, esFantasma: p.es_fantasma, horaRegistro: p.hora_registro,
                horaLlegadaEstimada: p.hora_llegada_estimada, estadoCocinaTexto: p.estado_cocina_texto, datosReserva: p.datos_reserva
            }));
            socket.emit('cargar-pedidos-cocina', pedidosPendientes);
        } catch (err) {
            console.error('Error al obtener pedidos:', err.message);
        }
    });

    // Escucha para despacho de platos
    socket.on('pedido-despachado-cocina', async (id) => {
        try {
            const { error } = await supabase
                .from('pedidos_cocina')
                .update({ estado: 'entregado' })
                .eq('id', id);
            
            if (error) throw error;
            io.emit('pedido-listo-retirar', id);
        } catch (err) {
            console.error('Error al despachar pedido:', err.message);
        }
    });
};