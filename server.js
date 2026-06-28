require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });

// Importación de módulos lógicos
const manejarCocina = require('./cocina.js');
const manejarReservas = require('./reservas.js');
const supabase = require('./db');

// Servir archivos estáticos
app.use(express.static('public'));

// Redirección raíz
app.get('/', (req, res) => { res.redirect('/quiosco.html'); });

// Orquestador de eventos
io.on('connection', async (socket) => {
    console.log(`Cliente conectado: ${socket.id}`);

    // Carga de estado inicial
    try {
        const { data: mesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
        const { data: menu } = await supabase.from('menu').select('*').order('id', { ascending: true });
        
        socket.emit('cargar-menu-inicial', menu || []);
        socket.emit('cargar-mesas-inicial', mesas || []);
    } catch (err) {
        console.error('Error al cargar estado inicial:', err.message);
    }

    // Delegación de lógica modular
    manejarCocina(io, socket);
    manejarReservas(io, socket);

    // Eventos de sistema global (si los necesitas fuera de los módulos)
    socket.on('cambiar-estado-mesa', async (datos) => {
        try {
            await supabase.from('mesas').update({ estado: datos.estado }).eq('numero', datos.numero);
            const { data: nuevasMesas } = await supabase.from('mesas').select('*').order('numero', { ascending: true });
            io.emit('mesas-actualizadas', nuevasMesas);
        } catch (err) {
            console.error('Error al actualizar mesa:', err.message);
        }
    });
});

// Configuración de puerto dinámico para despliegue web
const PORT = process.env.PORT || 3090;
http.listen(PORT, () => console.log(`🚀 Servidor profesional ejecutándose en puerto ${PORT}`));