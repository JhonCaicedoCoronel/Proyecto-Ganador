const path = require('path');
const supabase = require(path.join(__dirname, '../db'));

module.exports = (io, socket) => {
    socket.on('obtener-pedidos-cocina', async () => {
        try {
            const { data: pedidosDB } = await supabase.from('pedidos_cocina').select('*').eq('estado', 'pendiente').order('id', { ascending: true });
            socket.emit('cargar-pedidos-cocina', pedidosDB || []);
        } catch (err) {
            console.error('Error al obtener pedidos:', err.message);
        }
    });

    socket.on('pedido-despachado-cocina', async (id) => {
        try {
            await supabase.from('pedidos_cocina').update({ estado: 'entregado' }).eq('id', id);
            io.emit('pedido-listo-retirar', id);
        } catch (err) {
            console.error('Error al despachar pedido:', err.message);
        }
    });
};