const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const routes = require('./routes/routes');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Configurar dotenv para cargar variables de entorno
dotenv.config();

const app = express();
const server = http.createServer(app); // Crear servidor HTTP
const io = new Server(server, {
  cors: {
    origin: [process.env.FRONTEND_URL || 'http://localhost:3000', 'https://localhost'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true
  }
});

const PORT = process.env.PORT || 10000;

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

// Configuración de CORS permitiendo solicitudes desde el frontend
app.use(cors({
  origin: [FRONTEND_URL, 'https://localhost'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// Configuración de middleware
app.use(bodyParser.json({ limit: '50mb' })); // Ajusta el límite si es necesario

// Rutas de API
app.use('/api', (req, res, next) => {
  req.io = io; // Agregar el objeto io a la solicitud para usarlo en las rutas
  next();
}, routes);

// Rutas estáticas para servir archivos desde 'public/media'
const mediaPath = path.join(__dirname, 'public', 'media');
console.log(`Configuración de archivos estáticos en: ${mediaPath}`);
app.use('/media', express.static('public/media'));

const userSockets = {}; // Mapea IDs de usuario a sockets

io.on('connection', (socket) => {
  console.log(`Nuevo cliente conectado: ${socket.id}`);

  // Escucha un evento para registrar el usuario
  socket.on('register', (userId) => {
    userSockets[userId] = socket.id;
    socket.join(userId.toString()); // Une el socket a una sala con el ID del usuario
    console.log(`Usuario ${userId} registrado con socket ID: ${socket.id}`);
  });

  // Maneja la desconexión
  socket.on('disconnect', () => {
    for (const userId in userSockets) {
      if (userSockets[userId] === socket.id) {
        delete userSockets[userId];
        console.log(`Socket eliminado para usuario ${userId}`);
        break;
      }
    }
  });
});

// Inicio del servidor
server.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});