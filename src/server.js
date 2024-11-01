const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const routes = require('./routes/routes');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Configurar dotenv para cargar variables de entorno
dotenv.config();

const PORT = process.env.PORT || 10000;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const app = express();

// Configuración de CORS permitiendo solicitudes desde el frontend
app.use(cors({
  origin: [FRONTEND_URL, 'https://localhost'],
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

// Configuración de middleware
app.use(bodyParser.json({ limit: '10mb' })); // Ajusta el límite si es necesario

// Rutas de API
app.use('/api', routes);

// Rutas estáticas para servir archivos desde 'public/media'
const mediaPath = path.join(__dirname, 'public', 'media');
console.log(`Configuración de archivos estáticos en: ${mediaPath}`);
app.use('/media', express.static('public/media'));

// Inicio del servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
