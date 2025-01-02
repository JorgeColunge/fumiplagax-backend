const axios = require('axios');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const sharp = require('sharp');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const pool = require('../config/dbConfig');
const { v4: uuidv4 } = require('uuid');
const PizZip = require('pizzip');
const { xml2js, js2xml } = require('xml-js');
const Docxtemplater = require('docxtemplater');
const mammoth = require('mammoth');
const vm = require('vm');
const QRCode = require('qrcode');
const { uploadFile, getSignedUrl, deleteObject  } = require('../config/s3Service');

// Configuración de almacenamiento con Multer (en memoria para subir a S3)
const storage = multer.memoryStorage();

// Configuración del filtro para permitir solo imágenes
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif)'));
  }
};

// Middleware de multer para manejar imágenes en memoria
const uploadImage = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Límite de 5 MB
}).single('image');

// Middleware para comprimir imágenes usando sharp
const compressImage = async (req, res, next) => {
  if (!req.file) {
    return next();
  }

  try {
    // Generar un nombre único para la imagen procesada
    const compressedFileName = `${uuidv4()}.jpeg`;

    // Comprimir y redimensionar la imagen usando sharp
    const compressedImageBuffer = await sharp(req.file.buffer)
      .resize(150, 150) // Cambia el tamaño de la imagen a 150x150 píxeles
      .jpeg({ quality: 80 }) // Comprimir en formato JPEG con calidad 80
      .toBuffer();

    // Reemplazar el archivo original con la versión comprimida
    req.file.buffer = compressedImageBuffer;
    req.file.originalname = compressedFileName;

    next();
  } catch (error) {
    console.error('Error al comprimir la imagen:', error);
    res.status(500).json({ message: 'Error al procesar la imagen' });
  }
};

router.post('/updateProfile', uploadImage, compressImage, async (req, res) => {
  const { name, lastname, email, phone, userId, color } = req.body;

  let imageUrl = null;

  try {
    // Subir nueva imagen y eliminar la anterior si se proporciona
    if (req.file) {
      const result = await pool.query('SELECT image FROM users WHERE id = $1', [userId]);
      const previousImage = result.rows[0]?.image;

      if (previousImage && previousImage.includes('.amazonaws.com/')) {
        const bucketName = 'fumiplagax';
        const previousKey = previousImage.split('.amazonaws.com/')[1];
        await deleteObject(bucketName, previousKey); // Eliminar la imagen anterior
        console.log(`Imagen anterior eliminada: ${previousKey}`);
      }

      const bucketName = 'fumiplagax';
      const key = `profile_pictures/${Date.now()}-${req.file.originalname}`;
      const uploadResult = await uploadFile(bucketName, key, req.file.buffer);
      imageUrl = uploadResult.Location; // URL pública generada por S3
    }

    // Construir partes dinámicas para la consulta
    const fields = [];
    const values = [];
    let index = 1;

    if (name) fields.push(`name = $${index++}`) && values.push(name);
    if (lastname) fields.push(`lastname = $${index++}`) && values.push(lastname);
    if (email) fields.push(`email = $${index++}`) && values.push(email);
    if (phone) fields.push(`phone = $${index++}`) && values.push(phone);
    if (color) fields.push(`color = $${index++}`) && values.push(color);
    if (imageUrl) fields.push(`image = $${index++}`) && values.push(imageUrl);
    values.push(userId);

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No se enviaron datos para actualizar' });
    }

    const query = `UPDATE users SET ${fields.join(', ')} WHERE id = $${index}`;
    await pool.query(query, values);

    // Generar enlace prefirmado para la nueva imagen
    if (imageUrl) {
      const bucketName = 'fumiplagax';
      const key = imageUrl.split('.amazonaws.com/')[1];
      imageUrl = await getSignedUrl(bucketName, key); // Generar enlace prefirmado
    }

    res.json({ message: 'Perfil actualizado exitosamente', profilePicURL: imageUrl });
  } catch (error) {
    console.error('Error al actualizar el perfil:', error);
    res.status(500).json({ message: 'Error al actualizar el perfil' });
  }
});


// Ruta para subir y almacenar solo la URL de la imagen
router.post('/upload', uploadImage, compressImage, async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'Se requiere un ID de usuario para subir la imagen.' });
  }

  if (!req.file) {
    return res.status(400).json({ message: 'No se subió ningún archivo' });
  }

  try {
    // Subir archivo a S3
    const bucketName = 'fumiplagax'; // Cambia esto por el nombre de tu bucket
    const key = `profile_pictures/${Date.now()}-${req.file.originalname}`; // Ruta única en S3
    const result = await uploadFile(bucketName, key, req.file.buffer);

    // URL pública del archivo en S3
    const imageUrl = result.Location;

    // Obtener la imagen anterior para eliminarla si existe
    const userResult = await pool.query('SELECT image FROM users WHERE id = $1', [userId]);
    const previousImage = userResult.rows[0]?.image;

    if (previousImage && previousImage.includes('.amazonaws.com/')) {
      const previousKey = previousImage.split('.amazonaws.com/')[1];
      await deleteObject(bucketName, previousKey); // Eliminar la imagen anterior
      console.log(`Imagen anterior eliminada: ${previousKey}`);
    }

    // Actualizar la base de datos con la URL de la imagen
    const updateQuery = 'UPDATE users SET image = $1 WHERE id = $2';
    const values = [imageUrl, userId];
    await pool.query(updateQuery, values);

    res.json({ profilePicURL: imageUrl, message: 'Imagen subida y URL almacenada correctamente' });
  } catch (error) {
    console.error('Error al subir la imagen a S3 o actualizar la base de datos:', error);
    res.status(500).json({ message: 'Error al subir la imagen o almacenar la URL' });
  }
});

// Ruta de inicio de sesión
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(401).json({ success: false, message: "Invalid credentials" });
    
    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    
    if (isMatch) {
      res.json({
        success: true,
        message: "Login successful",
        user: { id_usuario: user.id, name: user.name, lastname: user.lastname, email: user.email, phone: user.phone, rol: user.rol, image: user.image }
      });
    } else {
      res.status(401).json({ success: false, message: "Invalid credentials" });
    }
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post('/register', uploadImage, compressImage, async (req, res) => {
  console.log("Received body:", req.body);
  console.log("Received file:", req.file);

  const { id, name, lastname, rol, email, phone, password, color } = req.body;

  if (!id || !name || !lastname || !rol || !email || !phone || !password) {
    console.error("Missing fields:", { id, name, lastname, rol, email, phone, password });
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  let imageUrl = null;

  try {
    // Verificar si el usuario ya existe
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      console.error("User already exists with email:", email);
      return res.status(400).json({ success: false, message: "User already exists" });
    }

    // Subir la imagen al bucket S3 si se proporciona
    if (req.file) {
      try {
        const bucketName = 'fumiplagax';
        const key = `profile_pictures/${Date.now()}-${req.file.originalname}`;
        const uploadResult = await uploadFile(bucketName, key, req.file.buffer);
        imageUrl = uploadResult.Location; // URL pública generada por S3
      } catch (uploadError) {
        console.error("Error uploading image to S3:", uploadError);
        imageUrl = null; // Establecer la URL como null en caso de error
      }
    }

    // Generar la contraseña encriptada
    const hashedPassword = await bcrypt.hash(password, 10);

    // Función para generar colores vibrantes aleatorios
    const getVibrantColor = () => {
      const r = Math.floor(Math.random() * 156) + 100; // Rojo (100-255)
      const g = Math.floor(Math.random() * 156) + 100; // Verde (100-255)
      const b = Math.floor(Math.random() * 156) + 100; // Azul (100-255)
      return `rgb(${r}, ${g}, ${b})`;
    };

    // Insertar el nuevo usuario en la base de datos
    await pool.query(
      'INSERT INTO users (id, name, lastname, rol, email, phone, password, image, color) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, name, lastname, rol, email, phone, hashedPassword, imageUrl, color ? color : getVibrantColor()]
    );

    // Generar URL prefirmada para la imagen, si existe
    let preSignedImageUrl = null;
    if (imageUrl) {
      try {
        const bucketName = 'fumiplagax';
        const key = imageUrl.includes('.amazonaws.com/')
          ? imageUrl.split('.amazonaws.com/')[1]
          : null;

        if (key) {
          preSignedImageUrl = await getSignedUrl(bucketName, key); // Generar enlace prefirmado
        } else {
          console.warn("Invalid S3 image URL format:", imageUrl);
        }
      } catch (signedUrlError) {
        console.error("Error generating signed URL:", signedUrlError);
        preSignedImageUrl = null; // Establecer como null en caso de error
      }
    }

    res.json({
      success: true,
      message: "User registered successfully",
      profilePicURL: preSignedImageUrl || imageUrl || null,
    });
  } catch (error) {
    console.error("Database or S3 error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// Nueva ruta para obtener todos los usuarios registrados
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users');
    const users = result.rows;

    // Generar URLs prefirmadas para las imágenes de cada usuario
    for (let user of users) {
      if (user.image) {
        try {
          const bucketName = 'fumiplagax';

          // Validar si la URL contiene el key esperado
          const key = user.image.includes('.amazonaws.com/')
            ? user.image.split('.amazonaws.com/')[1]
            : null;

          if (key) {
            user.image = await getSignedUrl(bucketName, key); // Generar enlace prefirmado
          } else {
            console.warn(`El usuario con ID ${user.id} tiene una imagen malformada.`);
            user.image = null; // Dejar la imagen como null si está malformada
          }
        } catch (err) {
          console.error(`Error generando URL prefirmada para el usuario con ID ${user.id}:`, err);
          user.image = null; // Manejar errores y dejar la imagen como null
        }
      } else {
        user.image = null; // Dejar como null si no tiene imagen
      }
    }

    res.json(users);
  } catch (error) {
    console.error("Error al obtener usuarios:", error);
    res.status(500).json({ message: 'Error al obtener usuarios' });
  }
});


// Ruta para eliminar un usuario
router.delete('/users/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.status(200).json({ message: 'Usuario eliminado exitosamente' });
  } catch (error) {
    console.error("Error al eliminar usuario:", error);
    res.status(500).json({ message: 'Error al eliminar el usuario' });
  }
});

// Ruta para obtener un usuario por ID
router.get('/users/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    const user = result.rows[0];

    // Generar URL prefirmada si el usuario tiene una imagen válida
    if (user.image) {
      try {
        const bucketName = 'fumiplagax';

        // Validar si la URL contiene el key esperado
        const key = user.image.includes('.amazonaws.com/')
          ? user.image.split('.amazonaws.com/')[1]
          : null;

        if (key) {
          user.image = await getSignedUrl(bucketName, key); // Generar enlace prefirmado
        } else {
          console.warn(`El usuario con ID ${user.id} tiene una imagen malformada.`);
          user.image = null; // Dejar la imagen como null si está malformada
        }
      } catch (err) {
        console.error(`Error generando URL prefirmada para el usuario con ID ${user.id}:`, err);
        user.image = null; // Manejar errores y dejar la imagen como null
      }
    } else {
      user.image = null; // Dejar como null si no tiene imagen
    }

    res.json(user);
  } catch (error) {
    console.error("Error al obtener usuario:", error);
    res.status(500).json({ message: 'Error al obtener el usuario' });
  }
});

// Crear cliente con geolocalización
router.post('/clients', async (req, res) => {
  const {
    name,
    address,
    department,
    city,
    phone,
    email,
    representative,
    document_type,
    document_number,
    contact_name,
    contact_phone,
    rut,
  } = req.body;

  // Concatenar dirección completa
  const fullAddress = `${address}, ${city}, ${department}`;

  try {
    // Obtener geolocalización
    const response = await axios.get(
      `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
        fullAddress
      )}&key=${process.env.GOOGLE_MAPS_API_KEY}`
    );

    if (response.data.status !== 'OK') {
      console.error('Geocoding error:', response.data.status);
      return res.status(400).json({
        success: false,
        message: 'Error al obtener geolocalización. Verifica la dirección proporcionada.',
      });
    }

    const { lat, lng } = response.data.results[0].geometry.location;

    // Insertar cliente en la base de datos
    const query = `
      INSERT INTO clients (
        name, address, department, city, phone, email, representative,
        document_type, document_number, contact_name, contact_phone, rut,
        latitude, longitude
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *
    `;
    const values = [
      name,
      address,
      department,
      city,
      phone,
      email,
      representative,
      document_type,
      document_number,
      contact_name,
      contact_phone,
      rut,
      lat,
      lng,
    ];
    const result = await pool.query(query, values);

    res.status(201).json({
      success: true,
      message: 'Cliente creado exitosamente con geolocalización',
      client: result.rows[0],
    });
  } catch (error) {
    console.error('Error creating client:', error);
    res.status(500).json({
      success: false,
      message: 'Error del servidor al crear el cliente',
    });
  }
});

// Obtener todos los clientes
router.get('/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clients');
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching clients:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener un cliente por ID
router.get('/clients/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM clients WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching client:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Editar cliente
router.put('/clients/:id', async (req, res) => {
  const { id } = req.params;
  const {
    name,
    address,
    department,
    city,
    phone,
    email,
    representative,
    document_type,
    document_number,
    contact_name,
    contact_phone,
    rut,
  } = req.body;

  try {
    let latitude = null;
    let longitude = null;

    // Verificar si hay cambios en los datos de dirección
    if (address || city || department) {
      // Concatenar dirección completa
      const fullAddress = `${address}, ${city}, ${department}`;

      // Obtener geolocalización
      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
          fullAddress
        )}&key=${process.env.GOOGLE_MAPS_API_KEY}`
      );

      if (response.data.status !== 'OK') {
        console.error('Geocoding error:', response.data.status);
        return res.status(400).json({
          success: false,
          message: 'Error al obtener geolocalización. Verifica la dirección proporcionada.',
        });
      }

      const location = response.data.results[0].geometry.location;
      latitude = location.lat;
      longitude = location.lng;
    }

    // Construir la consulta SQL dinámicamente según si hay geolocalización
    const fields = [
      'name = $1',
      'address = $2',
      'department = $3',
      'city = $4',
      'phone = $5',
      'email = $6',
      'representative = $7',
      'document_type = $8',
      'document_number = $9',
      'contact_name = $10',
      'contact_phone = $11',
      'rut = $12',
    ];

    const values = [
      name,
      address,
      department,
      city,
      phone,
      email,
      representative,
      document_type,
      document_number,
      contact_name,
      contact_phone,
      rut,
    ];

    if (latitude !== null && longitude !== null) {
      fields.push('latitude = $13', 'longitude = $14');
      values.push(latitude, longitude);
    }

    values.push(id);

    const query = `
      UPDATE clients
      SET ${fields.join(', ')}
      WHERE id = $${values.length} RETURNING *
    `;

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Cliente no encontrado',
      });
    }

    res.json({
      success: true,
      message: 'Cliente actualizado exitosamente',
      client: result.rows[0],
    });
  } catch (error) {
    console.error('Error al actualizar cliente:', error);
    res.status(500).json({
      success: false,
      message: 'Error del servidor al actualizar el cliente',
    });
  }
});


// Eliminar cliente
router.delete('/clients/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }
    res.json({ success: true, message: "Client deleted successfully" });
  } catch (error) {
    console.error("Error deleting client:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Crear servicio
router.post('/services', async (req, res) => {
  const { service_type, description, pest_to_control, intervention_areas, category, quantity_per_month, client_id, value, created_by, responsible, companion } = req.body;

  try {
    const query = `
      INSERT INTO services (service_type, description, pest_to_control, intervention_areas, category, quantity_per_month, client_id, value, created_by, responsible, companion)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *
    `;
    const values = [service_type, description, pest_to_control, intervention_areas, category, quantity_per_month, client_id, value, created_by, responsible, companion];
    const result = await pool.query(query, values);

    res.status(201).json({ success: true, message: "Service created successfully", service: result.rows[0] });
  } catch (error) {
    console.error("Error creating service:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener todos los servicios
router.get('/services', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM services');
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching services:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener un servicio por ID
router.get('/services/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM services WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching service:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Editar servicio
router.put('/services/:id', async (req, res) => {
  const { id } = req.params;
  const { service_type, description, pest_to_control, intervention_areas, category, quantity_per_month, client_id, value, created_by, responsible, companion } = req.body;

  try {
    const query = `
      UPDATE services
      SET service_type = $1, description = $2, pest_to_control = $3, intervention_areas = $4, category = $5,
          quantity_per_month = $6, client_id = $7, value = $8, created_by = $9, responsible = $10, companion = $11
      WHERE id = $12 RETURNING *
    `;
    const values = [service_type, description, pest_to_control, intervention_areas, category, quantity_per_month, client_id, value, created_by, responsible, companion, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.json({ success: true, message: "Service updated successfully", service: result.rows[0] });
  } catch (error) {
    console.error("Error updating service:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Eliminar servicio junto con inspecciones y programación de servicios relacionados
router.delete('/services/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Eliminar programación de servicios relacionados
    await pool.query('DELETE FROM service_schedule WHERE service_id = $1', [id]);
    console.log(`Service schedule entries for service ${id} deleted.`);

    // Eliminar inspecciones relacionadas con el servicio
    await pool.query('DELETE FROM inspections WHERE service_id = $1', [id]);
    console.log(`Inspections for service ${id} deleted.`);

    // Eliminar el servicio
    const result = await pool.query('DELETE FROM services WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }

    console.log(`Service ${id} deleted successfully.`);
    res.json({ success: true, message: "Service, related inspections, and service schedule entries deleted successfully" });
  } catch (error) {
    console.error("Error deleting service and related data:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

const productsStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, '..', 'uploads');
    
    // Verificar si la carpeta existe, si no, crearla
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    
    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Configuración de Multer para procesar archivos sin guardarlos localmente
const uploadProductFiles = multer({
  limits: { fileSize: 50 * 1024 * 1024 } // Límite de 50 MB
}).fields([
  { name: 'safety_data_sheet', maxCount: 1 },
  { name: 'technical_sheet', maxCount: 1 },
  { name: 'health_registration', maxCount: 1 },
  { name: 'emergency_card', maxCount: 1 }
]);


// Ruta para crear producto
router.post('/products', uploadProductFiles, async (req, res) => {
  const { name, description_type, dose, residual_duration, category } = req.body;

  console.log("Categorías:", category);

  // Convierte el arreglo de categorías en una cadena separada por comas
  const formattedCategory = Array.isArray(category) ? category.join(", ") : category;

  let fileUrls = {};

  const uploadFileToDrive = async (fileBuffer, filename, mimeType) => {
    const fileData = fileBuffer.toString('base64');
    try {
      const response = await axios.post(
        'https://script.google.com/macros/s/AKfycbypyU3rkJJHmFwvzeXCfWpeflEeSOryJYLn8HMs3cykpd6sAQMBl4xsRwtbeRPQkG6b/exec',
        { fileData, filename, mimeType },
        { timeout: 60000 } // Aumenta el tiempo de espera a 60 segundos
      );
      return response.data.fileUrl;
    } catch (error) {
      console.error(`Error uploading ${filename} to Google Drive:`, error.message);
      return null;
    }
  };

  if (req.files.safety_data_sheet) {
    const file = req.files.safety_data_sheet[0];
    fileUrls.safety_data_sheet = await uploadFileToDrive(file.buffer, file.originalname, file.mimetype);
  }
  if (req.files.technical_sheet) {
    const file = req.files.technical_sheet[0];
    fileUrls.technical_sheet = await uploadFileToDrive(file.buffer, file.originalname, file.mimetype);
  }
  if (req.files.health_registration) {
    const file = req.files.health_registration[0];
    fileUrls.health_registration = await uploadFileToDrive(file.buffer, file.originalname, file.mimetype);
  }
  if (req.files.emergency_card) {
    const file = req.files.emergency_card[0];
    fileUrls.emergency_card = await uploadFileToDrive(file.buffer, file.originalname, file.mimetype);
  }

  try {
    const query = `
      INSERT INTO products (name, description_type, dose, residual_duration, category, safety_data_sheet, technical_sheet, health_registration, emergency_card)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *
    `;
    const values = [
      name,
      description_type,
      dose,
      residual_duration,
      formattedCategory, // Aquí se utiliza la categoría formateada
      fileUrls.safety_data_sheet,
      fileUrls.technical_sheet,
      fileUrls.health_registration,
      fileUrls.emergency_card,
    ];

    const result = await pool.query(query, values);

    res.status(201).json({ success: true, message: "Product created successfully", product: result.rows[0] });
  } catch (error) {
    console.error("Error creating product:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener todos los productos
router.get('/products', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products');
    res.json(result.rows);
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener un producto por ID
router.get('/products/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching product:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Editar producto
router.put('/products/:id', async (req, res) => {
  const { id } = req.params;
  const { name, description_type, dose, residual_duration, safety_data_sheet, technical_sheet, health_registration, emergency_card } = req.body;

  try {
    const query = `
      UPDATE products
      SET name = $1, description_type = $2, dose = $3, residual_duration = $4, safety_data_sheet = $5,
          technical_sheet = $6, health_registration = $7, emergency_card = $8
      WHERE id = $9 RETURNING *
    `;
    const values = [name, description_type, dose, residual_duration, safety_data_sheet, technical_sheet, health_registration, emergency_card, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, message: "Product updated successfully", product: result.rows[0] });
  } catch (error) {
    console.error("Error updating product:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Eliminar producto
router.delete('/products/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.json({ success: true, message: "Product deleted successfully" });
  } catch (error) {
    console.error("Error deleting product:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Ruta para crear una nueva inspección
router.post('/inspections', async (req, res) => {
  const { date, time, service_id, inspection_type, inspection_sub_type } = req.body;

  // Validación de campos obligatorios
  if (!date || !time || !inspection_type || !service_id) {
    return res.status(400).json({
      success: false,
      message: "La fecha, hora, tipo de inspección y servicio son campos obligatorios.",
    });
  }

  try {
    const query = `
      INSERT INTO inspections (date, time, service_id, inspection_type, inspection_sub_type)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `;
    const values = [
      date,
      time,
      service_id,
      Array.isArray(inspection_type) ? inspection_type.join(", ") : inspection_type, // Convierte el array en texto si es necesario
      inspection_sub_type || null, // Si no hay sub tipo, inserta NULL
    ];
    const result = await pool.query(query, values);

    res.status(201).json({
      success: true,
      message: "Inspección creada exitosamente",
      inspection: result.rows[0],
    });
  } catch (error) {
    console.error("Error al crear inspección:", error);
    res.status(500).json({
      success: false,
      message: "Error en el servidor",
      error: error.message,
    });
  }
});

// Ruta para obtener todas las inspecciones
router.get('/inspections', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM inspections');
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener inspecciones:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para obtener una inspección por ID
router.get('/inspections/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM inspections WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Inspección no encontrada" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error al obtener inspección:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para actualizar una inspección
router.put('/inspections/:id', async (req, res) => {
  const { id } = req.params;
  const { date, time, duration, observations, service_id, exit_time } = req.body;

  // Validación de campos obligatorios
  if (!date || !time) {
    return res.status(400).json({ success: false, message: "La fecha y la hora son campos obligatorios." });
  }

  try {
    const query = `
      UPDATE inspections
      SET date = $1, time = $2, duration = $3, observations = $4, service_id = $5, exit_time = $6
      WHERE id = $7 RETURNING *
    `;
    const values = [date, time, duration, observations, service_id, exit_time, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Inspección no encontrada" });
    }
    res.json({ success: true, message: "Inspección actualizada exitosamente", inspection: result.rows[0] });
  } catch (error) {
    console.error("Error al actualizar inspección:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para eliminar una inspección
router.delete('/inspections/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM inspections WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Inspección no encontrada" });
    }
    res.json({ success: true, message: "Inspección eliminada exitosamente" });
  } catch (error) {
    console.error("Error al eliminar inspección:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para obtener todos los registros
router.get('/service-schedule', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM service_schedule');
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener los registros:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para obtener un registro por ID
router.get('/service-schedule/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM service_schedule WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Registro no encontrado" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error al obtener el registro:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

router.post('/service-schedule', async (req, res) => {
  const { service_id, date, start_time, end_time } = req.body;

  try {
    // Insertar el registro en la tabla de programación de servicios
    const result = await pool.query(
      'INSERT INTO service_schedule (service_id, date, start_time, end_time) VALUES ($1, $2, $3, $4) RETURNING id, service_id, date, start_time, end_time',
      [service_id, date, start_time, end_time]
    );

    // Obtener información del servicio
    const serviceQuery = await pool.query('SELECT * FROM services WHERE id = $1', [service_id]);
    const service = serviceQuery.rows[0];

    if (!service) {
      return res.status(404).json({ success: false, message: "Servicio no encontrado" });
    }

    const { responsible } = service;

    // Obtener información del responsable
    const responsibleQuery = await pool.query('SELECT * FROM users WHERE id = $1', [responsible]);
    const responsibleData = responsibleQuery.rows[0];

    if (!responsibleData) {
      return res.status(404).json({ success: false, message: "Responsable no encontrado" });
    }

    // Crear el evento para el frontend
    const newEvent = {
      id: result.rows[0].id,
      service_id: service_id,
      start: `${date}T${start_time}`,
      end: `${date}T${end_time}`,
      title: `${service_id}`,
      responsible,
      serviceType: service.service_type,
      color: responsibleData.color,
    };

    // Emitir evento al responsable asignado
    req.io.to(responsible.toString()).emit('newEvent', newEvent);
    console.log(`Evento emitido al responsable ${responsible}:`, newEvent);

    // Generar notificación
    const notificationMessage = `Tu servicio ${service_id} ha sido agendado para el ${date} a las ${start_time}.`;

    const notificationQuery = `
      INSERT INTO notifications (user_id, notification, state)
      VALUES ($1, $2, $3) RETURNING *
    `;
    const notificationValues = [responsible, notificationMessage, 'pending'];
    const notificationResult = await pool.query(notificationQuery, notificationValues);

    // Emitir la notificación al responsable
    req.io.to(responsible.toString()).emit('notification', {
      user_id: responsible,
      notification: notificationResult.rows[0],
    });
    console.log(`Notificación emitida al responsable ${responsible}:`, notificationMessage);

    // Responder con éxito
    res.status(201).json({
      success: true,
      message: "Registro creado con éxito",
      data: result.rows[0],
      notification: notificationResult.rows[0],
    });
  } catch (error) {
    console.error("Error al crear el registro:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para actualizar un registro
router.put('/service-schedule/:id', async (req, res) => {
  const { id } = req.params;
  const { service_id, date, start_time, end_time } = req.body;
  try {
    const result = await pool.query(
      'UPDATE service_schedule SET service_id = $1, date = $2, start_time = $3, end_time = $4 WHERE id = $5 RETURNING *',
      [service_id, date, start_time, end_time, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Registro no encontrado" });
    }
    res.json({ success: true, message: "Registro actualizado con éxito", data: result.rows[0] });
  } catch (error) {
    console.error("Error al actualizar el registro:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para eliminar un registro
router.delete('/service-schedule/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM service_schedule WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Registro no encontrado" });
    }
    res.json({ success: true, message: "Registro eliminado con éxito", data: result.rows[0] });
  } catch (error) {
    console.error("Error al eliminar el registro:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Obtener todas las estaciones
router.get('/stations', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM stations');
    const stations = result.rows;

    // Generar URLs prefirmadas solo si qr_code es válido
    for (let station of stations) {
      if (station.qr_code && station.qr_code.includes('.amazonaws.com/')) {
        const bucketName = 'fumiplagax';
        const key = station.qr_code.split('.amazonaws.com/')[1];

        if (key) {
          try {
            station.qr_code = await getSignedUrl(bucketName, key);
          } catch (urlError) {
            console.warn(`Failed to generate signed URL for station ID ${station.id}:`, urlError);
            station.qr_code = null; // En caso de error, se asigna null
          }
        } else {
          station.qr_code = null; // Si la clave no es válida
        }
      } else {
        station.qr_code = null; // Si no existe qr_code o está mal formado
      }
    }

    res.json(stations);
  } catch (error) {
    console.error("Error fetching stations:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener una estación por ID
router.get('/stations/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM stations WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Station not found" });
    }

    const station = result.rows[0];

    // Generar URL prefirmada solo si qr_code es válido
    if (station.qr_code && station.qr_code.includes('.amazonaws.com/')) {
      const bucketName = 'fumiplagax';
      const key = station.qr_code.split('.amazonaws.com/')[1];

      if (key) {
        try {
          station.qr_code = await getSignedUrl(bucketName, key);
        } catch (urlError) {
          console.warn(`Failed to generate signed URL for station ID ${station.id}:`, urlError);
          station.qr_code = null; // En caso de error, se asigna null
        }
      } else {
        station.qr_code = null; // Si la clave no es válida
      }
    } else {
      station.qr_code = null; // Si no existe qr_code o está mal formado
    }

    res.json(station);
  } catch (error) {
    console.error("Error fetching station:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Crear una nueva estación
router.post('/stations', async (req, res) => {
  const { description, category, type, control_method, client_id, qr_code } = req.body;

  try {
    const query = `
      INSERT INTO stations (description, category, type, control_method, client_id)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `;
    const values = [description, category, type, control_method, client_id];
    const result = await pool.query(query, values);

    const station = result.rows[0]; // Obtener la estación creada
    const stationId = station.id;

    // Generar el código QR en memoria
    const qrData = qr_code || `Station-${stationId}`;
    const qrBuffer = await QRCode.toBuffer(qrData, { width: 300 });

    // Subir el archivo QR a S3
    const bucketName = 'fumiplagax'; // Tu bucket S3
    const key = `stations/${Date.now()}-${uuidv4()}.png`;

    const uploadResult = await uploadFile(bucketName, key, qrBuffer);
    const qrUrl = uploadResult.Location; // URL pública de S3

    // Actualizar la base de datos con la URL del QR
    const updateQuery = `UPDATE stations SET qr_code = $1 WHERE id = $2`;
    await pool.query(updateQuery, [qrUrl, stationId]);

    // Generar URL prefirmada del QR
    const preSignedUrl = await getSignedUrl(bucketName, key);

    // Añadir la URL prefirmada al objeto estación
    station.qr_code = preSignedUrl;

    // Responder al frontend con toda la información de la estación
    res.status(201).json({ success: true, station });
  } catch (error) {
    console.error('Error creating station:', error);
    res.status(500).json({ success: false, message: 'Error creating station', error: error.message });
  }
});


// Actualizar una estación existente
router.put('/stations/:id', async (req, res) => {
  const { id } = req.params;
  const { description, category, type, control_method, client_id } = req.body;

  try {
    const query = `
      UPDATE stations
      SET description = $1, category = $2, type = $3, control_method = $4, client_id = $5
      WHERE id = $6 RETURNING *
    `;
    const values = [description, category, type, control_method, client_id, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Station not found" });
    }

    const station = result.rows[0];
    if (station.qr_code) {
      const bucketName = 'fumiplagax';
      const key = station.qr_code.split('.amazonaws.com/')[1];
      station.qr_code = await getSignedUrl(bucketName, key);
    }

    res.json({ success: true, message: "Station updated successfully", station });
  } catch (error) {
    console.error("Error updating station:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Eliminar una estación
router.delete('/stations/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM stations WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Station not found" });
    }

    res.json({ success: true, message: "Station deleted successfully", station: result.rows[0] });
  } catch (error) {
    console.error("Error deleting station:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener estaciones por ID del cliente
router.get('/stations/client/:client_id', async (req, res) => {
  const { client_id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM stations WHERE client_id = $1', [client_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "No stations found for the specified client" });
    }

    const stations = result.rows;

    // Generar URLs prefirmadas solo si hay una clave válida en qr_code
    for (let station of stations) {
      if (station.qr_code && station.qr_code.includes('.amazonaws.com/')) {
        const bucketName = 'fumiplagax';
        const keyParts = station.qr_code.split('.amazonaws.com/'); // Extraer clave
        const key = keyParts[1] || null;

        if (key) {
          station.qr_code = await getSignedUrl(bucketName, key);
        } else {
          console.warn(`Invalid QR Code URL format for station ID ${station.id}`);
          station.qr_code = null;
        }
      } else {
        station.qr_code = null; // Si no existe, establecer como null
      }
    }

    res.json(stations);
  } catch (error) {
    console.error("Error fetching stations by client_id:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


// Configuración de almacenamiento con Multer para inspecciones
const inspectionStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', '..', 'public', 'media', 'inspections'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// File filter para imágenes
const inspectionFileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);

  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten imágenes (jpeg, jpg, png, gif)'));
  }
};

const uploadInspectionImages = multer({
  storage: inspectionStorage,
  fileFilter: inspectionFileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // Límite de 5MB por archivo
}).fields([
  { name: "tech_signature", maxCount: 1 },
  { name: "client_signature", maxCount: 1 },
  { name: "findingsImages", maxCount: 20 },
  { name: "stationImages", maxCount: 20 },
  { name: "images", maxCount: 20 }, // Nuevo campo para imágenes genéricas
]);


router.post('/inspections/:inspectionId/save', uploadInspectionImages, async (req, res) => {
  try {
    const { inspectionId } = req.params;
    const { generalObservations, findingsByType, productsByType, stationsFindings, signatures } = req.body;

    console.log('Datos recibidos en el body:', {
      generalObservations,
      findingsByType,
      productsByType,
      stationsFindings,
      signatures,
    });

    // Parsear datos de strings a objetos si es necesario
    const parsedFindingsByType =
      typeof findingsByType === 'string' ? JSON.parse(findingsByType) : findingsByType;
    const parsedStationsFindings =
      typeof stationsFindings === 'string' ? JSON.parse(stationsFindings) : stationsFindings;
    const parsedSignatures =
      typeof signatures === 'string' ? JSON.parse(signatures) : signatures;

    console.log('findingsByType parseado:', JSON.stringify(parsedFindingsByType, null, 2));
    console.log('stationsFindings parseado:', JSON.stringify(parsedStationsFindings, null, 2));

    // Procesar imágenes recibidas
    const techSignaturePath = req.files.tech_signature
      ? `/media/inspections/${req.files.tech_signature[0].filename}`
      : parsedSignatures?.technician?.signature;

    const clientSignaturePath = req.files.client_signature
      ? `/media/inspections/${req.files.client_signature[0].filename}`
      : parsedSignatures?.client?.signature;

    const findingsImagePaths = req.files.findingsImages
      ? req.files.findingsImages.map((file) => `/media/inspections/${file.filename}`)
      : [];
    const stationImagePaths = req.files.stationImages
      ? req.files.stationImages.map((file) => `/media/inspections/${file.filename}`)
      : [];
    const genericImagePaths = req.files.images
      ? req.files.images.map((file) => `/media/inspections/${file.filename}`)
      : [];

    console.log('Rutas de imágenes procesadas:', {
      techSignaturePath,
      clientSignaturePath,
      findingsImagePaths,
      stationImagePaths,
      genericImagePaths, // Mostrar las imágenes genéricas procesadas
    });

    // Reconstruir el objeto signatures
    const updatedSignatures = {
      client: {
        id: parsedSignatures?.client?.id || null,
        name: parsedSignatures?.client?.name || null,
        position: parsedSignatures?.client?.position || null,
        signature: clientSignaturePath,
      },
      technician: {
        name: parsedSignatures?.technician?.name || "Técnico",
        signature: techSignaturePath,
      },
    };

    // Asociar imágenes a `findingsByType`
    let imageIndex = 0;
    Object.keys(parsedFindingsByType).forEach((type) => {
      parsedFindingsByType[type] = parsedFindingsByType[type].map((finding) => {
        if ((!finding.photo || finding.photo.startsWith('blob:')) && findingsImagePaths[imageIndex]) {
          finding.photo = findingsImagePaths[imageIndex];
          imageIndex++;
        }
        return finding;
      });
    });

    // Asociar imágenes a `stationsFindings`
    parsedStationsFindings.forEach((finding, index) => {
      if ((!finding.photo || finding.photo.startsWith('blob:')) && stationImagePaths[index]) {
        finding.photo = stationImagePaths[index];
      }
    });

    // Construir el objeto final de datos, incluyendo imágenes genéricas
    const findingsData = {
      findingsByType: parsedFindingsByType,
      productsByType: typeof productsByType === 'string' ? JSON.parse(productsByType) : productsByType,
      stationsFindings: parsedStationsFindings,
      signatures: updatedSignatures, // Usar el objeto signatures reconstruido
      genericImages: genericImagePaths, // Agregar imágenes genéricas al objeto
    };

    console.log('findingsData preparado para guardar en la base de datos:', JSON.stringify(findingsData, null, 2));

    // Query para actualizar la inspección en la base de datos
    const query = `
      UPDATE inspections
      SET 
        observations = $1,
        findings = $2,
        exit_time = NOW()
      WHERE id = $3
      RETURNING *;
    `;
    const values = [generalObservations, findingsData, inspectionId];

    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      console.warn(`Inspección no encontrada para ID: ${inspectionId}`);
      return res.status(404).json({ success: false, message: 'Inspección no encontrada' });
    }

    console.log('Datos guardados en la base de datos:', result.rows[0]);

    // Respuesta exitosa al cliente
    res.status(200).json({
      success: true,
      message: 'Inspección guardada exitosamente',
      inspection: result.rows[0],
      uploadedImages: {
        techSignature: techSignaturePath,
        clientSignature: clientSignaturePath,
        findingsImages: findingsImagePaths,
        stationImages: stationImagePaths,
        genericImages: genericImagePaths, // Retornar las imágenes genéricas procesadas
      },
    });
  } catch (error) {
    console.error('Error al guardar la inspección:', error);
    res.status(500).json({ success: false, message: 'Error al guardar la inspección' });
  }
});



// Marcar una notificación como leída
router.put('/notifications/:id/read', async (req, res) => {
  const { id } = req.params;

  try {
    const query = 'UPDATE notifications SET state = $1 WHERE id = $2 RETURNING *';
    const result = await pool.query(query, ['read', id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    res.json({ success: true, notification: result.rows[0] });
  } catch (error) {
    console.error('Error marking notification as read:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Editar notificación
router.put('/notifications/:id', async (req, res) => {
  const { id } = req.params;
  const { user_id, notification, state } = req.body;

  try {
    const query = `
      UPDATE notifications
      SET user_id = $1, notification = $2, state = $3
      WHERE id = $4 RETURNING *
    `;
    const values = [user_id, notification, state, id];
    const result = await pool.query(query, values);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification updated successfully", notification: result.rows[0] });
  } catch (error) {
    console.error("Error updating notification:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Eliminar notificación
router.delete('/notifications/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = `
      DELETE FROM notifications
      WHERE id = $1 RETURNING *
    `;
    const result = await pool.query(query, [id]);

    if (result.rowCount === 0) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification deleted successfully" });
  } catch (error) {
    console.error("Error deleting notification:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Obtener notificaciones de un usuario
router.get('/notifications/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const query = `
      SELECT * FROM notifications WHERE user_id = $1
    `;
    const values = [userId];
    const result = await pool.query(query, values);

    res.status(200).json({ success: true, notifications: result.rows });
  } catch (error) {
    console.error("Error fetching notifications:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Configuración de almacenamiento para documentos RUT
const rutStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, '..', '..', 'public', 'media', 'documents', 'clients', 'rut');

    // Verificar si la carpeta existe, si no, crearla
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Middleware de Multer para documentos RUT
const uploadRutFile = multer({
  storage: rutStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // Límite de 5 MB
}).single('rut');

// Ruta para subir el archivo RUT
router.post('/clients/upload-rut', uploadRutFile, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No se ha subido ningún archivo" });
    }

    // Construye la URL del archivo
    const fileUrl = `/media/documents/clients/rut/${req.file.filename}`;

    res.json({ success: true, fileUrl, message: "Archivo RUT subido exitosamente" });
  } catch (error) {
    console.error("Error al subir el archivo RUT:", error);
    res.status(500).json({ success: false, message: "Error al subir el archivo RUT" });
  }
});

// Configuración de almacenamiento para los archivos de facturación
const billingStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadPath = path.join(__dirname, '..', '..', 'public', 'media', 'billing');

    // Verificar si la carpeta existe, si no, crearla
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }

    cb(null, uploadPath);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Middleware de Multer para archivos de facturación
const uploadBillingFile = multer({
  storage: billingStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // Límite de 50 MB
}).single('file');

router.post('/billing', uploadBillingFile, async (req, res) => {
  try {
    const { billingData } = req.body; // Se espera que sea un string en JSON
    const fileUrl = req.file ? `/media/documents/billing/${req.file.filename}` : null;

    if (!billingData || !fileUrl) {
      return res.status(400).json({
        success: false,
        message: "Datos incompletos: Se requiere billingData y un archivo comprobante.",
      });
    }

    // Intentar parsear billingData a JSON
    let parsedBillingData;
    try {
      parsedBillingData = JSON.parse(billingData);
    } catch (error) {
      console.error('Error al parsear billingData:', error);
      return res.status(400).json({
        success: false,
        message: "El formato de billingData no es válido JSON.",
      });
    }

    // Log para verificar los datos antes de la inserción
    console.log('Datos de facturación procesados:', parsedBillingData);
    console.log('URL del archivo:', fileUrl);

    // Inserción en la base de datos
    const query = `
      INSERT INTO billing (client_id, billing_data, file_url, billing_date)
      VALUES ($1, $2, $3, NOW()) RETURNING *
    `;
    const values = [
      parsedBillingData[0].client_id, // ID del cliente
      JSON.stringify(parsedBillingData), // Asegurar que sea un string JSON
      fileUrl, // URL del archivo comprobante
    ];

    const result = await pool.query(query, values);

    res.status(201).json({
      success: true,
      message: "Factura creada exitosamente.",
      billing: result.rows[0],
    });
  } catch (error) {
    console.error('Error al crear factura:', error);
    res.status(500).json({
      success: false,
      message: "Error en el servidor al crear la factura.",
      error: error.message,
    });
  }
});

// Ruta para obtener todas las facturas
router.get('/billing', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM billing');
    res.json(result.rows);
  } catch (error) {
    console.error("Error al obtener facturas:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para obtener una factura por ID
router.get('/billing/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('SELECT * FROM billing WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Factura no encontrada" });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error al obtener factura:", error);
    res.status(500).json({ success: false, message: "Error en el servidor", error: error.message });
  }
});

// Ruta para editar una factura por ID
router.put('/billing/:id', uploadBillingFile, async (req, res) => {
  const { id } = req.params;
  const { billingData } = req.body;

  // Validación de datos
  if (!billingData && !req.file) {
    return res.status(400).json({
      success: false,
      message: "Se requiere al menos datos de facturación o un archivo actualizado.",
    });
  }

  try {
    const billingDataJson = billingData ? JSON.parse(billingData) : null;
    const fileUrl = req.file ? `/media/billing/${req.file.filename}` : null;

    const query = `
      UPDATE billing
      SET 
        billing_data = COALESCE($1, billing_data),
        file_url = COALESCE($2, file_url),
        billing_date = NOW()
      WHERE id = $3 RETURNING *
    `;
    const values = [
      billingDataJson ? billingDataJson : null,
      fileUrl,
      id,
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Factura no encontrada" });
    }

    res.json({
      success: true,
      message: "Factura actualizada exitosamente",
      billing: result.rows[0],
    });
  } catch (error) {
    console.error("Error al actualizar factura:", error);
    res.status(500).json({
      success: false,
      message: "Error en el servidor",
      error: error.message,
    });
  }
});

// Ruta para eliminar una factura por ID
router.delete('/billing/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = 'DELETE FROM billing WHERE id = $1 RETURNING *';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Factura no encontrada" });
    }

    res.json({
      success: true,
      message: "Factura eliminada exitosamente",
      billing: result.rows[0],
    });
  } catch (error) {
    console.error("Error al eliminar factura:", error);
    res.status(500).json({
      success: false,
      message: "Error en el servidor",
      error: error.message,
    });
  }
});

// Ruta para guardar mapas en la tabla client_maps
router.post('/maps', uploadImage, compressImage, async (req, res) => {
  const { client_id, description } = req.body;

  if (!client_id || !description || !req.file) {
    return res.status(400).json({ success: false, message: 'Faltan datos obligatorios' });
  }

  try {
    // Subir la imagen a S3
    const bucketName = 'fumiplagax';
    const key = `client_maps/${Date.now()}-${req.file.originalname}`; // Clave única para S3
    const s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`; // Construir URL de S3

    await uploadFile(bucketName, key, req.file.buffer); // Subir el archivo

    // Insertar la URL de S3 en la base de datos
    const query = `INSERT INTO client_maps (id, client_id, image, description) VALUES ($1, $2, $3, $4) RETURNING *`;
    const values = [uuidv4(), client_id, s3Url, description];
    const result = await pool.query(query, values);

    // Generar una URL prefirmada para la respuesta
    const signedUrl = await getSignedUrl(bucketName, key);

    res.status(201).json({
      success: true,
      message: 'Mapa guardado exitosamente',
      map: {
        ...result.rows[0], // Datos del mapa guardado
        image: signedUrl, // Reemplazar la URL con la prefirmada para la respuesta
      },
    });
  } catch (error) {
    console.error('Error al guardar el mapa:', error);
    res.status(500).json({ success: false, message: 'Error al guardar el mapa' });
  }
});

// Ruta para obtener todos los mapas de un cliente
router.get('/maps/:client_id', async (req, res) => {
  const { client_id } = req.params;

  try {
    const query = `SELECT * FROM client_maps WHERE client_id = $1`;
    const result = await pool.query(query, [client_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'No se encontraron mapas para este cliente' });
    }

    // Generar enlace prefirmado para cada imagen si es necesario
    const maps = await Promise.all(
      result.rows.map(async (map) => {

        if (
          map.image &&
          !map.image.includes('X-Amz-Algorithm') // Verifica si la URL ya está prefirmada
        ) {
          const bucketName = 'fumiplagax';
          const key = map.image.split('.amazonaws.com/')[1];

          try {
            map.image = await getSignedUrl(bucketName, key); // Generar enlace prefirmado
          } catch (err) {
            console.error(`[ERROR] Error generando URL prefirmada para la imagen ${key}:`, err);
            map.image = null; // Si hay un error, dejar la URL como null
          }
        } else {
        }

        return map;
      })
    );

    res.json({ success: true, maps });
  } catch (error) {
    console.error('[ERROR] Error al obtener mapas:', error);
    res.status(500).json({ success: false, message: 'Error al obtener mapas' });
  }
});


// Ruta para actualizar un mapa
router.put('/maps/:id', uploadImage, compressImage, async (req, res) => {
  const { id } = req.params;
  const { description } = req.body;

  try {
    const bucketName = 'fumiplagax';
    let s3Url = null;
    let signedUrl = null;

    // Verificar si se subió una nueva imagen
    if (req.file) {
      const key = `client_maps/${Date.now()}-${req.file.originalname}`;
      await uploadFile(bucketName, key, req.file.buffer);

      // Construir la URL pública de S3
      s3Url = `https://${bucketName}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      // Generar enlace prefirmado para la nueva imagen
      signedUrl = await getSignedUrl(bucketName, key);

      // Eliminar la imagen anterior si existe
      const previousImageQuery = await pool.query('SELECT image FROM client_maps WHERE id = $1', [id]);
      const previousImage = previousImageQuery.rows[0]?.image;
      if (previousImage && previousImage.includes('.amazonaws.com/')) {
        const previousKey = previousImage.split('.amazonaws.com/')[1];
        await deleteObject(bucketName, previousKey);
        console.log(`[INFO] Imagen anterior eliminada: ${previousKey}`);
      }
    }

    // Actualizar los datos del mapa
    const fields = [];
    const values = [];
    let index = 1;

    if (description) fields.push(`description = $${index++}`) && values.push(description);
    if (s3Url) fields.push(`image = $${index++}`) && values.push(s3Url);
    values.push(id);

    if (fields.length === 0) {
      return res.status(400).json({ success: false, message: 'No se enviaron datos para actualizar' });
    }

    const query = `UPDATE client_maps SET ${fields.join(', ')} WHERE id = $${index} RETURNING *`;
    const result = await pool.query(query, values);

    // Devolver el mapa actualizado con la URL prefirmada
    const updatedMap = result.rows[0];
    updatedMap.image = signedUrl || updatedMap.image; // Reemplazar la URL pública con la prefirmada en la respuesta

    res.json({ success: true, message: 'Mapa actualizado exitosamente', map: updatedMap });
  } catch (error) {
    console.error('[ERROR] Error al actualizar el mapa:', error);
    res.status(500).json({ success: false, message: 'Error al actualizar el mapa' });
  }
});


// Ruta para eliminar un mapa
router.delete('/maps/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Obtener la imagen asociada al mapa
    const query = `SELECT image FROM client_maps WHERE id = $1`;
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Mapa no encontrado' });
    }

    const imageUrl = result.rows[0].image;

    // Eliminar la imagen de S3
    if (imageUrl) {
      const bucketName = 'fumiplagax';

      // Extraer la clave del objeto S3 a partir de la URL pública
      const keyMatch = imageUrl.match(/client_maps\/.+$/); // Buscar "client_maps/" y todo lo que sigue
      if (keyMatch) {
        const key = keyMatch[0]; // Obtener la clave
        await deleteObject(bucketName, key); // Eliminar el objeto de S3
      } else {
        console.warn(`[WARNING] No se pudo extraer la clave de la URL: ${imageUrl}`);
      }
    }

    // Eliminar el registro de la base de datos
    const deleteQuery = `DELETE FROM client_maps WHERE id = $1 RETURNING *`;
    const deleteResult = await pool.query(deleteQuery, [id]);

    res.json({ success: true, message: 'Mapa eliminado exitosamente', map: deleteResult.rows[0] });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Error al eliminar el mapa' });
  }
});

router.get('/rules', async (req, res) => {
  try {
    const rulesData = await pool.query('SELECT * FROM rules'); // Cambia esto según tu base de datos
    res.json(rulesData.rows);
  } catch (error) {
    console.error('Error al obtener las normas:', error);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
});

// Obtener todas las reglas
router.get('/rules', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM rules');
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al obtener las reglas');
  }
});

// Agregar una nueva regla
router.post('/rules', async (req, res) => {
  const { rule, description, categoryId } = req.body; // categoryId es el id de la categoría seleccionada
  try {
    const result = await pool.query(
      `INSERT INTO rules (rule, description, category) 
       VALUES ($1, $2, $3) 
       RETURNING *`,
      [rule || 'Norma', description || 'Descripción', categoryId]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error al agregar la norma:', error.message);
    res.status(500).json({ success: false, message: 'Error al agregar la norma' });
  }
});

// Editar una regla
router.put('/rules/:id', async (req, res) => {
  const { id } = req.params;
  const { rule, description, category } = req.body;
  try {
    await pool.query(
      'UPDATE rules SET rule = $1, description = $2, category = $3 WHERE id = $4',
      [rule, description, category, id]
    );
    res.send('Regla actualizada correctamente');
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al actualizar la regla');
  }
});

// Eliminar una regla
router.delete('/rules/:id', async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM rules WHERE id = $1', [id]);
    res.send('Regla eliminada correctamente');
  } catch (err) {
    console.error(err.message);
    res.status(500).send('Error al eliminar la regla');
  }
});

// Ruta para agregar una nueva categoría
router.post('/rules/categories', async (req, res) => {
  const { category } = req.body;

  if (!category) {
    return res.status(400).json({ success: false, message: 'El nombre de la categoría es obligatorio' });
  }

  try {
    // Inserta la categoría en la tabla rules_category
    const result = await pool.query(
      `INSERT INTO rules_category (category) 
       VALUES ($1) 
       ON CONFLICT (category) DO NOTHING 
       RETURNING id, category`,
      [category.trim()]
    );

    if (result.rowCount === 0) {
      return res.status(409).json({ success: false, message: 'La categoría ya existe' });
    }

    res.status(201).json({ success: true, category: result.rows[0] });
  } catch (error) {
    console.error('Error al agregar la categoría:', error.message);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
});

// Ruta para obtener todas las categorías únicas
router.get('/rules/categories', async (req, res) => {
  try {
    // Consulta para obtener todas las categorías con su id y nombre
    const result = await pool.query('SELECT id, category AS name FROM rules_category WHERE category IS NOT NULL');
    res.json(result.rows);
  } catch (error) {
    console.error('Error al obtener las categorías:', error.message);
    res.status(500).json({ success: false, message: 'Error en el servidor' });
  }
});

const templateFilter = (req, file, cb) => {
  if (file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    cb(null, true);
  } else {
    cb(new Error('Solo se permiten archivos .docx'));
  }
};

const uploadDocx = multer({
  storage,
  templateFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB límite
}).single('file');

const bucketName = 'fumiplagax';
const templatesPath = 'documents/templates/';

// Ruta para crear una nueva plantilla
router.post('/upload-template', uploadDocx, async (req, res) => {
  const { templateData } = req.body; // Recibimos el JSON de la plantilla

  if (!req.file || !templateData) {
    return res.status(400).json({ message: 'Faltan datos requeridos' });
  }

  try {
    // Parsear el templateData recibido como JSON
    const parsedTemplateData = JSON.parse(templateData);
    const { nombrePlantilla, variables, tablas } = parsedTemplateData;

    if (!nombrePlantilla || !variables || !tablas) {
      return res.status(400).json({ message: 'Datos de la plantilla incompletos' });
    }

    // Subir el archivo a S3
    const key = `${templatesPath}${uuidv4()}-${req.file.originalname}`;
    const uploadResult = await uploadFile(bucketName, key, req.file.buffer);

    // Guardar los datos en la base de datos
    const query = `
      INSERT INTO plantillas (nombre, datos, url_archivo, fecha_creacion)
      VALUES ($1, $2, $3, NOW()) RETURNING *;
    `;
    const values = [
      nombrePlantilla,
      { variables, tablas }, // Guardamos las variables y tablas como JSON
      uploadResult.Location,
    ];

    const result = await pool.query(query, values);

    res.status(201).json({ message: 'Plantilla creada con éxito', plantilla: result.rows[0] });
  } catch (error) {
    console.error('Error al subir la plantilla:', error);
    res.status(500).json({ message: 'Error al crear la plantilla' });
  }
});

// Ruta para editar una plantilla
router.put('/update-template/:id', uploadDocx, async (req, res) => {
  const { id } = req.params;
  const { nombre, templateData } = req.body;

  if (!nombre || !templateData) {
    return res.status(400).json({ message: 'Faltan datos requeridos' });
  }

  try {
    // Obtener información previa de la plantilla
    const query = 'SELECT url_archivo FROM plantillas WHERE id = $1';
    const previousResult = await pool.query(query, [id]);

    if (previousResult.rows.length === 0) {
      return res.status(404).json({ message: 'Plantilla no encontrada' });
    }

    const previousUrl = previousResult.rows[0].url_archivo;

    let newUrl = previousUrl;

    // Si se sube un nuevo archivo, reemplazar el anterior
    if (req.file) {
      const previousKey = previousUrl.split('.amazonaws.com/')[1];
      await deleteObject(bucketName, previousKey);

      const key = `${templatesPath}${uuidv4()}-${req.file.originalname}`;
      const uploadResult = await uploadFile(bucketName, key, req.file.buffer);
      newUrl = uploadResult.Location;
    }

    // Actualizar la plantilla en la base de datos
    const updateQuery = `
      UPDATE plantillas SET nombre = $1, datos = $2, url_archivo = $3
      WHERE id = $4 RETURNING *;
    `;
    const values = [nombre, JSON.parse(templateData), newUrl, id];
    const result = await pool.query(updateQuery, values);

    res.json({ message: 'Plantilla actualizada', plantilla: result.rows[0] });
  } catch (error) {
    console.error('Error al actualizar la plantilla:', error);
    res.status(500).json({ message: 'Error al actualizar la plantilla' });
  }
});

// Ruta para eliminar una plantilla
router.delete('/delete-template/:id', async (req, res) => {
  const { id } = req.params;

  try {
    // Obtener información de la plantilla
    const query = 'SELECT url_archivo FROM plantillas WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Plantilla no encontrada' });
    }

    const fileUrl = result.rows[0].url_archivo;
    const fileKey = fileUrl.split('.amazonaws.com/')[1];

    // Eliminar archivo de S3
    await deleteObject(bucketName, fileKey);

    // Eliminar registro de la base de datos
    const deleteQuery = 'DELETE FROM plantillas WHERE id = $1';
    await pool.query(deleteQuery, [id]);

    res.json({ message: 'Plantilla eliminada correctamente' });
  } catch (error) {
    console.error('Error al eliminar la plantilla:', error);
    res.status(500).json({ message: 'Error al eliminar la plantilla' });
  }
});

// Ruta para obtener información de una plantilla
router.get('/get-template/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const query = 'SELECT * FROM plantillas WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Plantilla no encontrada' });
    }

    const plantilla = result.rows[0];

    // Generar URL prefirmada
    const key = plantilla.url_archivo.split('.amazonaws.com/')[1];
    const signedUrl = await getSignedUrl(bucketName, key);

    res.json({ plantilla, signedUrl });
  } catch (error) {
    console.error('Error al obtener la plantilla:', error);
    res.status(500).json({ message: 'Error al obtener la plantilla' });
  }
});

router.get('/get-templates', async (req, res) => {
  try {
    const query = 'SELECT id, nombre FROM plantillas ORDER BY fecha_creacion DESC';
    const result = await pool.query(query);

    res.json({ templates: result.rows });
  } catch (error) {
    console.error('Error al obtener plantillas:', error);
    res.status(500).json({ message: 'Error al obtener plantillas' });
  }
});

// Función para transformar las entidades
const transformEntity = (entity) => {
  const entityMapping = {
    cliente: 'clients',
    servicio: 'services',
    usuario: 'users',
    inspeccion: 'inspections',
  };
  return entityMapping[entity] || entity;
};

// Ruta principal para almacenar configuración y código generado
router.post('/save-configuration', async (req, res) => {
  const { templateId, variables, tablas, entity } = req.body;

  try {
    console.log("=== Iniciando almacenamiento de configuración ===");

    // Validar entradas requeridas
    if (!entity || !templateId || !variables) {
      return res.status(400).json({ message: "Faltan campos requeridos: 'entity', 'templateId' o 'variables'." });
    }

    // Transformar la entidad a su forma plural
    const transformedEntity = transformEntity(entity);
    console.log("Entidad transformada:", transformedEntity);

    // Generar código dinámico
    const generatedCode = `
            const createDocument_${transformedEntity} = async (idEntity) => {
              console.log("ID de la entidad recibida:", idEntity);

              // Definición de valores preconfigurados
              const entity = "${transformedEntity}";
              const templateId = "${templateId}";
              let variables = ${JSON.stringify(variables, null, 2)};
              let tablas = ${JSON.stringify(tablas, null, 2)};
              let aiModels = ${JSON.stringify(aiModels, null, 2)};

              // Función para realizar consultas a GPT
              const consultarGPT = async (modelo, personalidad, prompt) => {
                const apiKey = "aqui va la apikeyssa";
                const url = "https://api.openai.com/v1/chat/completions";
                const headers = {
                  Authorization: \`Bearer \${apiKey}\`,
                  "Content-Type": "application/json",
                };
                const payload = {
                  model: modelo,
                  messages: [
                    { role: "system", content: personalidad },
                    { role: "user", content: prompt },
                  ],
                };

                try {
                  const responseGpt = await axios.post(url, payload, { headers });
                  const resultado = responseGpt.data.choices[0].message.content.trim();

                  // Cálculo del uso de tokens
                  const usage = responseGpt.data.usage;
                  const inputTokens = usage.prompt_tokens;
                  const outputTokens = usage.completion_tokens;

                  // Deja la sección de envío comentada por ahora
                  /*
                  const backendUrl = "https://botix.axiomarobotics.com:10000/api/consumptions";
                  const backendPayloadInput = {
                    api_name: "GPT",
                    model: modelo,
                    unit_type: "input_token",
                    unit_count: inputTokens,
                    query_details: "consulta personalizada",
                    company_id: integrationDetails.company_id,
                    user_id: responsibleUserId,
                    conversationId: conversationId,
                  };
                  await axios.post(backendUrl, backendPayloadInput);

                  const backendPayloadOutput = {
                    api_name: "GPT",
                    model: modelo,
                    unit_type: "output_token",
                    unit_count: outputTokens,
                    query_details: "consulta personalizada",
                    company_id: integrationDetails.company_id,
                    user_id: responsibleUserId,
                    conversationId: conversationId,
                  };
                  await axios.post(backendUrl, backendPayloadOutput);
                  */

                  return resultado;
                } catch (error) {
                  console.error("Error al obtener respuesta de GPT:", error);
                  return "Error al obtener la respuesta";
                }
              };

              let defaultWidthEMU = 990000; // Ancho en EMU
              let cellWidthEMU = defaultWidthEMU; // Variable global para el ancho de celda

              const isImageUrl = (url) => {
                const isImage = /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(url);
                console.log(\`Verificando si "\${url}" es una URL de imagen: \${isImage}\`);
                return isImage;
              };


              const addImageToDocx = async (zip, imageUrl, imageName) => {
                const response = await fetch(imageUrl);
                if (!response.ok) {
                  throw new Error(\`Error al descargar la imagen: \${imageUrl}\`);
                }
              
                const imageBuffer = await response.arrayBuffer();
              
                // Agregar la imagen al archivo ZIP en \`word/media/\`
                zip.file(\`word/media/\${imageName}\`, Buffer.from(imageBuffer));
              };
              
              const addImageRelationship = (zip, imageName) => {
                const relsPath = "word/_rels/document.xml.rels";
                const relationshipType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image";
                let relsXml;
              
                // 1. Verificar si el archivo document.xml.rels existe
                if (zip.files[relsPath]) {
                  console.log("El archivo 'document.xml.rels' existe. Cargando contenido...");
                  relsXml = zip.files[relsPath].asText();
                } else {
                  console.warn("El archivo 'document.xml.rels' no existe. Creando uno nuevo...");
                  relsXml = \`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>\`;
                  zip.file(relsPath, relsXml);
                }
              
                // 2. Obtener el ID máximo existente en el archivo de relaciones
                const existingIds = [...relsXml.matchAll(/Id="rId(\\d+)"/g)].map((match) => parseInt(match[1], 10));
                const maxExistingId = existingIds.length > 0 ? Math.max(...existingIds) : 0;
                let uniqueId = \`rId\${maxExistingId + 1}\`;
              
                console.log(\`Generando nueva relación con ID: \${uniqueId}\`);
              
                // 3. Verificar si la imagen ya está referenciada
                if (relsXml.includes(\`media/\${imageName}\`)) {
                  console.warn(\`La relación para '\${imageName}' ya existe. No se agregará duplicado.\`);
                  const existingIdMatch = relsXml.match(new RegExp(\`Id="(rId\\d+)"[^>]*Target="media/\${imageName}"\`));
                  const existingId = existingIdMatch ? existingIdMatch[1] : uniqueId;
                  return existingId; // Devolver el ID existente
                }
              
                // 4. Insertar la nueva relación
                const updatedRelsXml = relsXml.replace(
                  "</Relationships>",
                  \`<Relationship Id="\${uniqueId}" Type="\${relationshipType}" Target="media/\${imageName}"/></Relationships>\`
                );
              
                // 5. Guardar el archivo actualizado en el ZIP
                zip.file(relsPath, updatedRelsXml);
                console.log(\`Nueva relación añadida para '\${imageName}' con ID '\${uniqueId}'.\`);
              
                return uniqueId; // Devolver el nuevo ID
              };    

              const getValueFromJson = (json, keyPath, type = null) => {
                  const keys = keyPath.split('_');
                  let currentValue = json;

                  for (const [index, key] of keys.entries()) {
                    if (type && key === 'findingsByType') {
                      // Manejar findingsByType con el campo type
                      if (type === 'all') {
                        // Combinar todos los tipos
                        const allFindings = Object.values(currentValue[key] || {}).flat();
                        currentValue = allFindings; // Continuar navegando con todos los hallazgos
                      } else {
                        // Filtrar por tipo específico
                        currentValue = currentValue[key]?.[type] || [];
                      }

                      // Continuar con las claves restantes
                      const remainingKeys = keys.slice(index + 1);
                      if (remainingKeys.length > 0) {
                        return currentValue
                          .map((finding) => getValueFromJson(finding, remainingKeys.join('_')))
                          .flat();
                      }

                      return currentValue;
                    } else if (key === 'stationsFindings') {
                      // Manejar findings_stationsFindings_<Category>_<Field>
                      const category = keys[index + 1]; // La categoría está en la siguiente clave
                      const field = keys[index + 2]; // El campo específico está dos niveles más abajo

                      if (!category || !field) {
                        console.warn(\`No se encontró una categoría o campo válido en la ruta: \${keyPath}\`);
                        return "No encontrado";
                      }

                      // Filtrar stationsFindings por categoría, o incluir todas si la categoría es "all"
                      const filteredStations = category === "all"
                        ? currentValue[key] || [] // Incluir todas las estaciones si la categoría es "all"
                        : currentValue[key]?.filter((station) => station.category === category) || [];

                      // Retornar los valores del campo específico
                      const results = filteredStations.map((station) =>
                        station.hasOwnProperty(field) ? station[field] : "No encontrado"
                      );

                      return results.length > 0 ? results : "No encontrado";
                    } else if (type && key === 'productsByType') {
                      // Manejar productsByType con el campo type
                      if (type === 'all') {
                        const allProducts = Object.values(currentValue[key] || {});
                        currentValue = allProducts;
                      } else {
                        currentValue = currentValue[key]?.[type] || {};
                      }

                      const remainingKeys = keys.slice(index + 1);
                      if (remainingKeys.length > 0) {
                        return getValueFromJson(currentValue, remainingKeys.join('_'));
                      }

                      return currentValue;
                    } else if (currentValue && typeof currentValue === 'object' && key in currentValue) {
                      // Navegar por las claves normalmente
                      currentValue = currentValue[key];
                    } else {
                      console.warn(\`No se encontró la clave "\${key}" en el JSON.\`);
                      return "No encontrado";
                    }
                  }

                  return currentValue;
                };

              // Consultar campos dinámicos de las entidades "clients", "stations" y "client_maps"
              if (entity === "clients") {
                const queryClientData = 'SELECT * FROM clients WHERE id = $1';
                const resultClientData = await pool.query(queryClientData, [idEntity]);

                if (resultClientData.rows.length === 0) {
                  throw new Error(\`No se encontró la entidad "clients" con ID: \${idEntity}\`);
                }

                const clientData = resultClientData.rows[0];
                console.log("Datos de la entidad 'clients' obtenidos:", clientData);

                const queryStationsData = 'SELECT * FROM stations WHERE client_id = $1';
                const resultStationsData = await pool.query(queryStationsData, [idEntity]);
                const stationsData = resultStationsData.rows.length > 0 ? resultStationsData.rows : [];

                const queryClientMapsData = 'SELECT * FROM client_maps WHERE client_id = $1';
                const resultClientMapsData = await pool.query(queryClientMapsData, [idEntity]);
                const clientMapsData = resultClientMapsData.rows.length > 0 ? resultClientMapsData.rows : [];

                const queryServicesData = 'SELECT * FROM services WHERE client_id = $1';
                const resultServicesData = await pool.query(queryServicesData, [idEntity]);
                const servicesData = resultServicesData.rows.length > 0 ? resultServicesData.rows : [];

                // Consultar inspecciones relacionadas con los servicios del cliente
                const queryInspectionsData = \`SELECT * FROM inspections WHERE service_id = ANY ($1)\`;
                const serviceIds = servicesData.map((service) => service.id); // Obtener los IDs de los servicios del cliente
                const resultInspectionsData = await pool.query(queryInspectionsData, [serviceIds]);

                // Validar si se obtuvieron inspecciones
                const inspectionsData = resultInspectionsData.rows.length > 0 ? resultInspectionsData.rows : [];
                console.log("Datos de la entidad 'inspections' obtenidos:", inspectionsData);

                console.log("Datos de la entidad 'stations' obtenidos:", stationsData);
                console.log("Datos de la entidad 'client_maps' obtenidos:", clientMapsData);
                console.log("Datos de la entidad 'services' obtenidos:", servicesData);

                // Función auxiliar para actualizar valores según tipo de datos
                const updateValue = (data, field, type) => {
                  if (data && data.hasOwnProperty(field)) {
                    console.log(\`Valor encontrado para "\${field}" en "\${type}": \${data[field]}\`);
                    return data[field];
                  } else {
                    console.warn(\`El campo "\${field}" no existe en la entidad "\${type}".\`);
                    return "No encontrado";
                  }
                };

                // Función para filtrar servicios por período y tipo
                const filterServices = (services, periodo, tipoServicio) => {
                  const now = moment();
                  let filteredServices = services;

                  if (periodo !== "all") {
                    filteredServices = services.filter(service => {
                      const serviceDate = moment(service.created_at);
                      switch (periodo) {
                        case "this_year":
                          return serviceDate.isSame(now, 'year');
                        case "last_3_months":
                          return serviceDate.isAfter(now.clone().subtract(3, 'months'));
                        case "last_month":
                          return serviceDate.isSame(now.clone().subtract(1, 'month'), 'month');
                        case "this_week":
                          return serviceDate.isSame(now, 'week');
                        default:
                          return false;
                      }
                    });
                  }

                  // Convertir \`service_type\` en un array y buscar \`tipoServicio\`
                  if (tipoServicio === "all") {
                    return filteredServices; // No aplicar ningún filtro adicional
                  }

                  return filteredServices.filter(service => {
                    const serviceTypes = service.service_type
                      .replace(/^{|}$/g, '') // Eliminar las llaves {}
                      .split(',') // Dividir por comas
                      .map(type => type.trim().replace(/"/g, '')); // Eliminar comillas y espacios

                    return serviceTypes.includes(tipoServicio);
                  });
                };

                // Procesar variables
                Object.entries(variables).forEach(([key, value]) => {
                  if (value.startsWith("Cliente-")) {
                    const field = value.split('-')[1];
                    variables[key] = updateValue(clientData, field, "clients");
                  } else if (value.startsWith("Mapas-")) {
                    const field = value.split('-')[1];
                    variables[key] = clientMapsData[0] ? updateValue(clientMapsData[0], field, "client_maps") : "No encontrado";
                  } else if (value.startsWith("Estaciones Roedores-")) {
                    const stationField = value.split('-')[1];
                    // Filtrar las estaciones que pertenecen a la categoría "Roedores"
                    const filteredStations = stationsData.filter((station) => station.category === "Roedores");

                    if (filteredStations.length > 0) {
                      variables[key] = filteredStations[0].hasOwnProperty(stationField)
                        ? filteredStations[0][stationField]
                        : "No encontrado";
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else {
                      console.warn(\`No se encontraron estaciones para la categoría "Roedores".\`);
                      variables[key] = "No encontrado";
                    }
                  } else if (value.startsWith("Estaciones Aéreas-")) {
                    const stationField = value.split('-')[1];
                    // Filtrar las estaciones que pertenecen a la categoría "Aéreas"
                    const filteredStations = stationsData.filter((station) => station.category === "Aéreas");

                    if (filteredStations.length > 0) {
                      variables[key] = filteredStations[0].hasOwnProperty(stationField)
                        ? filteredStations[0][stationField]
                        : "No encontrado";
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else {
                      console.warn(\`No se encontraron estaciones para la categoría "Aéreas".\`);
                      variables[key] = "No encontrado";
                    }
                  } else if (value.startsWith("Servicios-")) {
                    const [_, periodo, tipoServicio, campo] = value.split('-'); // Extraer <Periodo>, <Tipo de servicio>, <Campo>
                    const filteredServices = filterServices(servicesData, periodo, tipoServicio);
                    if (filteredServices.length > 0 && filteredServices[0].hasOwnProperty(campo)) {
                      variables[key] = filteredServices[0][campo];
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else {
                      console.warn(\`No se encontraron servicios para el período "\${periodo}", tipo "\${tipoServicio}", o el campo "\${campo}".\`);
                      variables[key] = "No encontrado";
                    }
                  } else if (value.startsWith("Inspecciones-")) {
                    const [_, periodo, tipoInspeccion, campo] = value.split('-'); // Extraer <Periodo>, <Tipo de inspección>, <Campo>
                    console.log(\`Filtrando inspecciones para "\${periodo}" y tipo "\${tipoInspeccion}"...\`);

                    // Filtrar inspecciones por período
                    let filteredInspections = inspectionsData;
                    if (periodo !== "all") {
                      const now = moment();
                      filteredInspections = inspectionsData.filter((inspection) => {
                        const inspectionDate = moment(inspection.date);
                        switch (periodo) {
                          case "this_year":
                            return inspectionDate.isSame(now, 'year');
                          case "last_3_months":
                            return inspectionDate.isAfter(now.clone().subtract(3, 'months'));
                          case "last_month":
                            return inspectionDate.isSame(now.clone().subtract(1, 'month'), 'month');
                          case "this_week":
                            return inspectionDate.isSame(now, 'week');
                          default:
                            return false;
                        }
                      });
                    }

                    console.log(\`Inspecciones filtradas por período (\${periodo}):\`, filteredInspections);

                    // Filtrar por tipo de inspección
                    if (tipoInspeccion !== "all") {
                      filteredInspections = filteredInspections.filter((inspection) => {
                        const inspectionTypes = inspection.inspection_type
                          .split(',')
                          .map((type) => type.trim().toLowerCase());

                        return inspectionTypes.includes(tipoInspeccion.toLowerCase());
                      });
                    }

                    console.log(\`Inspecciones filtradas por tipo (\${tipoInspeccion}):\`, filteredInspections);

                    // Manejar campos del JSON de findings
                    if (campo.startsWith("findings_")) {
                      const keyPath = campo.replace('findings_', ''); // Extraer jerarquía de claves
                      if (filteredInspections.length > 0) {
                        variables[key] = getValueFromJson(filteredInspections[0].findings, keyPath, tipoInspeccion);
                      } else {
                        console.warn(\`No se encontraron inspecciones con findings para el período "\${periodo}" y tipo "\${tipoInspeccion}".\`);
                        variables[key] = "No encontrado";
                      }
                    } 
                  }
                });

                console.log("Variables actualizadas después de las consultas:", variables);

                // Procesar tablas
                tablas.forEach((tabla) => {
                  console.log(\`\\n=== Procesando tabla: \${tabla.nombre} ===\`);
                  console.log("Cuerpo original de la tabla:", tabla.cuerpo);

                  const nuevoCuerpo = [];

                  tabla.cuerpo.forEach((row) => {
                  // Crear un array para almacenar todos los valores de cada campo de la fila
                  const valoresPorCampo = row.map((field) => {
                    if (field.startsWith("Cliente-")) {
                      const clientField = field.split('-')[1];
                      return clientData.hasOwnProperty(clientField)
                        ? [clientData[clientField]]
                        : [];
                    } else if (field.startsWith("Mapas-")) {
                      const mapField = field.split('-')[1];
                      return clientMapsData[0]
                        ? [updateValue(clientMapsData[0], mapField, "client_maps")]
                        : [];
                    } else if (field.startsWith("Estaciones Roedores-")) {
                      const stationField = field.split('-')[1];
                      return stationsData
                        .filter((station) => station.category === "Roedores")
                        .map((station) =>
                          station.hasOwnProperty(stationField)
                            ? station[stationField]
                            : []
                        );
                    } else if (field.startsWith("Estaciones Aéreas-")) {
                      const stationField = field.split('-')[1];
                      return stationsData
                        .filter((station) => station.category === "Aéreas")
                        .map((station) =>
                          station.hasOwnProperty(stationField)
                            ? station[stationField]
                            : []
                        );
                    } else if (field.startsWith("Servicios-")) {
                      const [_, periodo, tipoServicio, campo] = field.split('-');
                      return filterServices(servicesData, periodo, tipoServicio).map((service) =>
                        service.hasOwnProperty(campo)
                          ? service[campo]
                          : []
                      );
                    } else if (field.startsWith("Inspecciones-")) {
                      const [_, periodo, tipoInspeccion, campo] = field.split('-');
                      console.log(\`Procesando inspecciones para "\${periodo}" y tipo "\${tipoInspeccion}" en tablas...\`);

                      // Filtrar inspecciones por período
                      let filteredInspections = inspectionsData;
                      if (periodo !== "all") {
                        const now = moment();
                        filteredInspections = inspectionsData.filter((inspection) => {
                          const inspectionDate = moment(inspection.date);
                          switch (periodo) {
                            case "this_year":
                              return inspectionDate.isSame(now, 'year');
                            case "last_3_months":
                              return inspectionDate.isAfter(now.clone().subtract(3, 'months'));
                            case "last_month":
                              return inspectionDate.isSame(now.clone().subtract(1, 'month'), 'month');
                            case "this_week":
                              return inspectionDate.isSame(now, 'week');
                            default:
                              return false;
                          }
                        });
                      }

                      console.log(\`Inspecciones filtradas por período (\${periodo}):\`, filteredInspections);

                      // Filtrar por tipo de inspección
                      if (tipoInspeccion !== "all") {
                        filteredInspections = filteredInspections.filter((inspection) => {
                          const inspectionTypes = inspection.inspection_type
                            .split(',')
                            .map((type) => type.trim().toLowerCase());

                          return inspectionTypes.includes(tipoInspeccion.toLowerCase());
                        });
                      }

                      console.log(\`Inspecciones filtradas por tipo (\${tipoInspeccion}):\`, filteredInspections);

                      // Manejar campos del JSON de findings
                      if (campo.startsWith("findings_")) {
                        const keyPath = campo.replace('findings_', ''); // Extraer jerarquía de claves
                        const findings = filteredInspections
                          .map((inspection) => getValueFromJson(inspection.findings, keyPath, tipoInspeccion))
                          .flat(); // Asegurarse de aplanar para manejar múltiples hallazgos

                        return findings.filter((value) => value !== "No encontrado" && value !== null && value !== undefined);
                      } else {
                        // Generar valores para otros campos
                        return filteredInspections
                          .map((inspection) => (inspection.hasOwnProperty(campo) ? inspection[campo] : []))
                          .filter((value) => value !== "No encontrado" && value !== null && value !== undefined);
                      }
                    } else {
                      return [field]; // Mantener el valor original si no coincide con ninguna regla
                    }
                  });

                  // Determinar el número máximo de registros para esta fila
                  const maxFilas = Math.max(...valoresPorCampo.map((valores) => valores.length));

                  // Generar filas alineadas, pero filtrar las vacías
                  for (let i = 0; i < maxFilas; i++) {
                    const nuevaFila = valoresPorCampo.map((valores) => valores[i] || null);
                    // Filtrar filas vacías antes de agregar al cuerpo
                    if (nuevaFila.some((valor) => valor !== null && valor !== "No encontrado" && valor !== "")) {
                      nuevoCuerpo.push(nuevaFila);
                    }
                  }
                });

                // Actualizar el cuerpo de la tabla con las nuevas filas generadas
                tabla.cuerpo = nuevoCuerpo;
                console.log(\`Tabla "\${tabla.nombre}" actualizada:\`, tabla.cuerpo);
                });
              }

              // Consultar campos dinámicos para la entidad "services"
              else if (entity === "services") {
                const queryServiceData = 'SELECT * FROM services WHERE id = $1';
                const queryClientData = 'SELECT * FROM clients WHERE id = $1';
                const queryUserData = 'SELECT * FROM users WHERE id = $1';
                const queryInspections = 'SELECT * FROM inspections WHERE service_id = $1';

                try {
                  // Consultar datos del servicio
                  const resultServiceData = await pool.query(queryServiceData, [idEntity]);

                  if (resultServiceData.rows.length === 0) {
                    throw new Error(\`No se encontró la entidad "services" con ID: \${idEntity}\`);
                  }

                  const serviceData = resultServiceData.rows[0];
                  console.log('Datos de la entidad "services" obtenidos:', serviceData);

                  // Consultar datos del cliente relacionado con el servicio
                  const resultClientData = await pool.query(queryClientData, [serviceData.client_id]);

                  if (resultClientData.rows.length === 0) {
                    throw new Error(\`No se encontró el cliente relacionado con el servicio con ID: \${serviceData.client_id}\`);
                  }

                  const clientData = resultClientData.rows[0];
                  console.log('Datos de la entidad "clients" obtenidos:', clientData);

                  // Consultar datos del responsable relacionado con el servicio
                  const resultUserData = await pool.query(queryUserData, [serviceData.responsible]);
                  const responsibleData = resultUserData.rows.length > 0 ? resultUserData.rows[0] : null;

                  // Procesar el campo "companion" para consultar datos de los acompañantes
                  const companionIdsRaw = serviceData.companion.replace(/{/g, "[").replace(/}/g, "]"); // Reemplazar llaves por corchetes
                  let companionIds;

                  try {
                    companionIds = JSON.parse(companionIdsRaw).map((id) => id.trim());
                    console.log("IDs de acompañantes extraídos:", companionIds);
                  } catch (error) {
                    console.error("Error al parsear el campo 'companion':", error);
                    companionIds = []; // Si hay un error, asignar un array vacío
                  }

                  // Consultar datos de los acompañantes
                  const companionData = [];
                  for (const companionId of companionIds) {
                    const resultCompanionData = await pool.query(queryUserData, [companionId]);
                    if (resultCompanionData.rows.length > 0) {
                      companionData.push(resultCompanionData.rows[0]);
                    } else {
                      console.warn(\`No se encontró usuario para el ID de acompañante: \${companionId}\`);
                      companionData.push(null); // Si no se encuentra el usuario, agregar un null
                    }
                  }
                  console.log("Datos de los acompañantes obtenidos:", companionData);


                  // Consultar datos de inspecciones relacionados con el servicio
                  const resultInspections = await pool.query(queryInspections, [idEntity]);
                  const inspectionsData = resultInspections.rows;

                  console.log('Datos de inspecciones obtenidos:', inspectionsData);

                  // Procesar variables específicas para "services"
                  Object.entries(variables).forEach(([key, value]) => {
                    if (value.startsWith("Servicio-")) {
                      const field = value.split('-')[1];
                      variables[key] = serviceData.hasOwnProperty(field) ? serviceData[field] : "No encontrado";
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else if (value.startsWith("Cliente-")) {
                      const field = value.split('-')[1];
                      variables[key] = clientData.hasOwnProperty(field) ? clientData[field] : "No encontrado";
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else if (value.startsWith("Responsable-")) {
                      const field = value.split('-')[1];
                      variables[key] = responsibleData && responsibleData.hasOwnProperty(field) ? responsibleData[field] : "No encontrado";
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else if (value.startsWith("Acompañante-")) {
                      const field = value.split('-')[1];
                      const companionValues = companionData
                        .filter((companion) => companion) // Filtrar valores null
                        .map((companion) => (companion && companion.hasOwnProperty(field) ? companion[field] : "No encontrado"));
                      variables[key] = companionValues.join(", "); // Combina todos los valores en un string separado por comas
                      console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                    } else if (value.startsWith("Inspecciones-")) {
                      const [_, periodo, tipoInspeccion, campo] = value.split('-'); // Extraer los parámetros
                      console.log(\`Filtrando inspecciones para "\${periodo}" y tipo "\${tipoInspeccion}"...\`);

                      // Filtrar inspecciones por período
                      let filteredInspections = inspectionsData;
                      if (periodo !== "all") {
                        const now = moment();
                        filteredInspections = filteredInspections.filter((inspection) => {
                          const inspectionDate = moment(inspection.date);
                          switch (periodo) {
                            case "this_year":
                              return inspectionDate.isSame(now, 'year');
                            case "last_3_months":
                              return inspectionDate.isAfter(now.clone().subtract(3, 'months'));
                            case "last_month":
                              return inspectionDate.isSame(now.clone().subtract(1, 'month'), 'month');
                            case "this_week":
                              return inspectionDate.isSame(now, 'week');
                            default:
                              return false;
                          }
                        });
                      }

                      // Filtrar por tipo de inspección
                      if (tipoInspeccion !== "all") {
                        filteredInspections = filteredInspections.filter((inspection) => {
                          const inspectionTypes = inspection.inspection_type
                            .split(',')
                            .map((type) => type.trim().toLowerCase());
                          return inspectionTypes.includes(tipoInspeccion.toLowerCase());
                        });
                      }

                      console.log(\`Inspecciones filtradas:\`, filteredInspections);

                      // Asignar valores según el campo especificado
                      if (filteredInspections.length > 0) {
                        if (campo.startsWith("findings_")) {
                          const keyPath = campo.replace('findings_', ''); // Extraer jerarquía de claves
                          variables[key] = getValueFromJson(filteredInspections[0].findings, keyPath, tipoInspeccion) || "No encontrado";
                        } else {
                          variables[key] = filteredInspections[0][campo] || "No encontrado";
                        }
                      } else {
                        console.warn(\`No se encontraron inspecciones para "\${periodo}" y tipo "\${tipoInspeccion}".\`);
                        variables[key] = "No encontrado";
                      }
                    } else {
                        if (filteredInspections.length > 0 && filteredInspections[0].hasOwnProperty(campo)) {
                          variables[key] = filteredInspections[0][campo];
                        } else {
                          console.warn(\`No se encontraron inspecciones para el período "\${periodo}", tipo "\${tipoInspeccion}", o el campo "\${campo}".\`);
                          variables[key] = "No encontrado";
                        }
                      }
                  });

                  // Procesar tablas específicas para "services"
                  tablas.forEach((tabla) => {
                    const nuevoCuerpo = []; // Nuevo cuerpo para la tabla

                    tabla.cuerpo.forEach((row) => {
                      const valoresPorCampo = row.map((field) => {
                        if (field.startsWith("Servicio-")) {
                          const serviceField = field.split('-')[1];
                          return [serviceData[serviceField] || "No encontrado"];
                        } else if (field.startsWith("Cliente-")) {
                          const clientField = field.split('-')[1];
                          return [clientData[clientField] || "No encontrado"];
                        } else if (field.startsWith("Responsable-")) {
                          const userField = field.split('-')[1];
                          return [responsibleData && responsibleData[userField] || "No encontrado"];
                        } else if (field.startsWith("Acompañante-")) {
                          const userField = field.split('-')[1];
                          return companionData
                            .filter((companion) => companion) // Filtrar valores null
                            .map((companion) => (companion && companion.hasOwnProperty(userField) ? companion[userField] : "No encontrado"));
                        } else if (field.startsWith("Inspecciones-")) {
                          const [_, periodo, tipoInspeccion, campo] = field.split('-');
                          console.log(\`Procesando inspecciones para "\${periodo}" y tipo "\${tipoInspeccion}" en tablas...\`);

                          // Filtrar inspecciones por período
                          let filteredInspections = inspectionsData;
                          if (periodo !== "all") {
                            const now = moment();
                            filteredInspections = inspectionsData.filter((inspection) => {
                              const inspectionDate = moment(inspection.date);
                              switch (periodo) {
                                case "this_year":
                                  return inspectionDate.isSame(now, 'year');
                                case "last_3_months":
                                  return inspectionDate.isAfter(now.clone().subtract(3, 'months'));
                                case "last_month":
                                  return inspectionDate.isSame(now.clone().subtract(1, 'month'), 'month');
                                case "this_week":
                                  return inspectionDate.isSame(now, 'week');
                                default:
                                  return false;
                              }
                            });
                          }

                          console.log(\`Inspecciones filtradas por período (\${periodo}):\`, filteredInspections);

                          // Filtrar por tipo de inspección
                          if (tipoInspeccion !== "all") {
                            filteredInspections = filteredInspections.filter((inspection) => {
                              const inspectionTypes = inspection.inspection_type
                                .split(',')
                                .map((type) => type.trim().toLowerCase());

                              return inspectionTypes.includes(tipoInspeccion.toLowerCase());
                            });
                          }

                          console.log(\`Inspecciones filtradas por tipo (\${tipoInspeccion}):\`, filteredInspections);

                          // Manejar campos del JSON de findings
                          if (campo.startsWith("findings_")) {
                            const keyPath = campo.replace('findings_', ''); // Extraer jerarquía de claves
                            const findings = filteredInspections
                              .map((inspection) => getValueFromJson(inspection.findings, keyPath, tipoInspeccion))
                              .flat(); // Asegurarse de aplanar para manejar múltiples hallazgos

                            return findings.filter((value) => value !== "No encontrado" && value !== null && value !== undefined);
                          } else {
                            // Generar valores para otros campos
                            return filteredInspections
                              .map((inspection) => (inspection.hasOwnProperty(campo) ? inspection[campo] : []))
                              .filter((value) => value !== "No encontrado" && value !== null && value !== undefined);
                          }
                        } else {
                          return [field]; // Mantener el valor original si no coincide con ninguna regla
                        }
                      });

                      // Determinar el número máximo de valores para esta fila
                      const maxFilas = Math.max(...valoresPorCampo.map((valores) => valores.length));

                      // Generar nuevas filas alineadas con los valores obtenidos
                      for (let i = 0; i < maxFilas; i++) {
                        const nuevaFila = valoresPorCampo.map((valores) => valores[i] || null);

                        // Filtrar filas vacías: solo agregar si hay al menos un valor válido
                        if (nuevaFila.some((valor) => valor !== null && valor !== "No encontrado" && valor !== "")) {
                          nuevoCuerpo.push(nuevaFila);
                        }
                      }
                    });

                    // Reemplazar el cuerpo de la tabla con las nuevas filas generadas
                    tabla.cuerpo = nuevoCuerpo;
                  });
                } catch (error) {
                  console.error("Error al procesar datos para la entidad 'services':", error);
                  throw new Error("No se pudieron procesar los datos del servicio.");
                }
              }

              else if (entity === "inspections") {
              const queryInspectionData = 'SELECT * FROM inspections WHERE id = $1';
              const queryServiceData = 'SELECT * FROM services WHERE id = $1'; // Consulta para servicios
              const queryClientData = 'SELECT * FROM clients WHERE id = $1'; // Consulta para clientes
              const queryUserData = 'SELECT * FROM users WHERE id = $1'; // Consulta para usuarios

              try {
                // Consultar datos de la inspección
                const resultInspectionData = await pool.query(queryInspectionData, [idEntity]);

                if (resultInspectionData.rows.length === 0) {
                  throw new Error(\`No se encontró la entidad "inspections" con ID: \${idEntity}\`);
                }

                const inspectionData = resultInspectionData.rows[0];
                console.log('Datos de la entidad "inspections" obtenidos:', inspectionData);

                // Consultar datos del servicio relacionado
                let serviceData = {};
                if (inspectionData.service_id) {
                  const resultServiceData = await pool.query(queryServiceData, [inspectionData.service_id]);

                  if (resultServiceData.rows.length === 0) {
                    console.warn(\`No se encontró el servicio relacionado con ID: \${inspectionData.service_id}\`);
                  } else {
                    serviceData = resultServiceData.rows[0];
                    console.log('Datos del servicio obtenidos:', serviceData);
                  }
                }

                // Consultar datos del cliente relacionado
                let clientData = {};
                if (serviceData.client_id) {
                  const resultClientData = await pool.query(queryClientData, [serviceData.client_id]);

                  if (resultClientData.rows.length === 0) {
                    console.warn(\`No se encontró el cliente relacionado con ID: \${serviceData.client_id}\`);
                  } else {
                    clientData = resultClientData.rows[0];
                    console.log('Datos del cliente obtenidos:', clientData);
                  }
                }

                let responsibleData = {};
                if (serviceData.responsible) {
                  const resultUserData = await pool.query(queryUserData, [serviceData.responsible]);

                  if (resultUserData.rows.length === 0) {
                    console.warn(\`No se encontró el usuario responsable con ID: \${serviceData.responsible}\`);
                  } else {
                    responsibleData = resultUserData.rows[0];
                    console.log('Datos del responsable obtenidos:', responsibleData);
                  }
                }

                // Procesar el campo "companion" para consultar datos de los acompañantes
                let companionData = [];
                if (serviceData.companion) {
                  const companionIdsRaw = serviceData.companion.replace(/{/g, "[").replace(/}/g, "]"); // Reemplazar llaves por corchetes
                  let companionIds;

                  try {
                    companionIds = JSON.parse(companionIdsRaw).map((id) => id.trim());
                    console.log("IDs de acompañantes extraídos:", companionIds);
                  } catch (error) {
                    console.error("Error al parsear el campo 'companion':", error);
                    companionIds = []; // Si hay un error, asignar un array vacío
                  }

                  // Consultar datos de los acompañantes
                  for (const companionId of companionIds) {
                    const resultCompanionData = await pool.query(queryUserData, [companionId]);
                    if (resultCompanionData.rows.length > 0) {
                      companionData.push(resultCompanionData.rows[0]);
                    } else {
                      console.warn(\`No se encontró usuario para el ID de acompañante: \${companionId}\`);
                      companionData.push(null); // Si no se encuentra el usuario, agregar un null
                    }
                  }
                  console.log("Datos de los acompañantes obtenidos:", companionData);
                }

                // Procesar variables específicas para "inspections"
                Object.entries(variables).forEach(([key, value]) => {
                  if (typeof value === 'string' && value.startsWith("Inspección-")) {
                    const [_, periodo, tipoInspeccion, campo] = value.split('-');

                    console.log(\`Procesando variable para tipo: "\${tipoInspeccion}" y campo: "\${campo}"\`);

                    if (campo.startsWith("findings_")) {
                      const keyPath = campo.replace('findings_', ''); // Extraer jerarquía de claves
                      variables[key] = getValueFromJson(inspectionData.findings || {}, keyPath, tipoInspeccion) || "No encontrado";
                    } else {
                      variables[key] = inspectionData[campo] || "No encontrado";
                    }
                  } else if (typeof value === 'string' && value.startsWith("Servicio-")) {
                    const serviceField = value.split('-')[1];
                    console.log(\`Procesando variable del servicio para campo: "\${serviceField}"\`);

                    variables[key] = serviceData[serviceField] || "No encontrado";
                  } else if (typeof value === 'string' && value.startsWith("Cliente-")) {
                    const clientField = value.split('-')[1];
                    console.log(\`Procesando variable del cliente para campo: "\${clientField}"\`);

                    variables[key] = clientData[clientField] || "No encontrado";
                  } else if (typeof value === 'string' && value.startsWith("Responsable-")) {
                    const userField = value.split('-')[1];
                    console.log(\`Procesando variable del responsable para campo: "\${userField}"\`);

                    variables[key] = responsibleData[userField] || "No encontrado";
                    console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                  } else if (typeof value === 'string' && value.startsWith("Acompañante-")) {
                    const field = value.split('-')[1];
                    const companionValues = companionData
                      .filter((companion) => companion) // Filtrar valores null
                      .map((companion) => (companion && companion.hasOwnProperty(field) ? companion[field] : "No encontrado"));
                    variables[key] = companionValues.join(", "); // Combina todos los valores en un string separado por comas
                    console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                  }

                  console.log(\`Variable "\${key}" actualizada a: \${variables[key]}\`);
                });

                // Procesar tablas específicas para "inspections"
                tablas.forEach((tabla) => {
                  const nuevoCuerpo = [];
                  const filasPorCampo = []; // Almacena las filas generadas para cada campo

                  tabla.cuerpo.forEach((row) => {
                    row.forEach((field) => {
                      if (typeof field === 'string' && field.startsWith("Inspección-")) {
                        const [_, periodo, tipoInspeccion, campo] = field.split('-');

                        console.log(\`Procesando campo para tipo: "\${tipoInspeccion}" y campo: "\${campo}"\`);

                        if (campo.startsWith("findings_")) {
                          const keyPath = campo.replace('findings_', ''); // Extraer jerarquía de claves
                          const findings = getValueFromJson(inspectionData.findings || {}, keyPath, tipoInspeccion);

                          if (Array.isArray(findings)) {
                            findings.forEach((finding, index) => {
                              if (!filasPorCampo[index]) filasPorCampo[index] = [];
                              filasPorCampo[index].push(finding || "No encontrado");
                            });
                          } else {
                            if (!filasPorCampo[0]) filasPorCampo[0] = [];
                            filasPorCampo[0].push(findings || "No encontrado");
                          }
                        } else {
                          if (!filasPorCampo[0]) filasPorCampo[0] = [];
                          filasPorCampo[0].push(inspectionData[campo] || "No encontrado");
                        }
                      } else if (typeof field === 'string' && field.startsWith("Servicio-")) {
                        const serviceField = field.split('-')[1];

                        console.log(\`Procesando campo del servicio para campo: "\${serviceField}"\`);

                        if (!filasPorCampo[0]) filasPorCampo[0] = [];
                        filasPorCampo[0].push(serviceData[serviceField] || "No encontrado");
                      } else if (typeof field === 'string' && field.startsWith("Cliente-")) {
                        const clientField = field.split('-')[1];

                        console.log(\`Procesando campo del cliente para campo: "\${clientField}"\`);

                        if (!filasPorCampo[0]) filasPorCampo[0] = [];
                        filasPorCampo[0].push(clientData[clientField] || "No encontrado");
                      } else if (typeof field === 'string' && field.startsWith("Responsable-")) {
                        const userField = field.split('-')[1];

                        console.log(\`Procesando campo del responsable para campo: "\${userField}"\`);

                        if (!filasPorCampo[0]) filasPorCampo[0] = [];
                        filasPorCampo[0].push(responsibleData[userField] || "No encontrado");
                      } else if (typeof field === 'string' && field.startsWith("Acompañante-")) {
                        const userField = field.split('-')[1];
                        const companionValues = companionData
                          .filter((companion) => companion) // Filtrar valores null
                          .map((companion) => (companion && companion.hasOwnProperty(userField) ? companion[userField] : "No encontrado"));

                        // Cada valor de los acompañantes debe añadirse como una nueva fila
                        companionValues.forEach((value, index) => {
                          if (!filasPorCampo[index]) filasPorCampo[index] = [];
                          filasPorCampo[index].push(value);
                        });
                      } else {
                        // Si no es un campo dinámico, lo mantenemos igual
                        if (!filasPorCampo[0]) filasPorCampo[0] = [];
                        filasPorCampo[0].push(field);
                      }
                    });
                  });

                  // Convertir filasPorCampo a formato de tabla
                  filasPorCampo.forEach((fila) => {
                    nuevoCuerpo.push(fila);
                  });

                  // Actualizar el cuerpo de la tabla
                  tabla.cuerpo = nuevoCuerpo;
                  console.log(\`Tabla "\${tabla.nombre}" actualizada:\`, tabla.cuerpo);
                });
              } catch (error) {
                console.error("Error al procesar datos para la entidad 'inspections':", error);
                throw new Error("No se pudieron procesar los datos de la inspección.");
              }
            }

              // 1. Obtener plantilla desde S3
              console.log("Obteniendo plantilla...");
              const queryTemplate = 'SELECT * FROM plantillas WHERE id = $1';
              const resultTemplate = await pool.query(queryTemplate, [templateId]);

              if (resultTemplate.rows.length === 0) {
                throw new Error("Plantilla no encontrada.");
              }

              const plantilla = resultTemplate.rows[0];
              const plantillaKey = decodeURIComponent(plantilla.url_archivo.split('.amazonaws.com/')[1]);
              console.log("Clave decodificada de la plantilla en S3:", plantillaKey);

              const signedUrl = await getSignedUrl(bucketName, plantillaKey);
              console.log("URL firmada generada:", signedUrl);
              const response = await fetch(signedUrl);
              if (!response.ok) throw new Error("Error al descargar la plantilla.");

              const plantillaBuffer = Buffer.from(await response.arrayBuffer());
              const zip = new PizZip(plantillaBuffer);
              let documentXml = zip.files['word/document.xml'].asText();

              // 2. Procesar XML
              console.log("Procesando documento XML...");
              const parsedXml = xml2js(documentXml, { compact: false, spaces: 4 });

              // Función para normalizar nodos de texto distribuidos
              const normalizeTextNodes = (nodes) => {
                nodes.forEach((node) => {
                  if (node.type === 'element' && node.name === 'w:p' && Array.isArray(node.elements)) {
                    let combinedText = '';
                    let variableNodes = [];
                    let isVariableOpen = false;

                    node.elements.forEach((child) => {
                      if (child.type === 'element' && child.name === 'w:r' && Array.isArray(child.elements)) {
                        child.elements.forEach((grandchild) => {
                          if (grandchild.type === 'element' && grandchild.name === 'w:t' && grandchild.elements) {
                            const text = grandchild.elements[0]?.text || '';

                            if (text.includes('{{')) {
                              isVariableOpen = true;
                              combinedText = text;
                              variableNodes.push({ parent: child, node: grandchild });
                            } else if (isVariableOpen) {
                              combinedText += text;
                              variableNodes.push({ parent: child, node: grandchild });

                              if (text.includes('}}')) {
                                isVariableOpen = false;

                                const firstNode = variableNodes[0];
                                if (firstNode) firstNode.node.elements[0].text = combinedText;

                                variableNodes.slice(1).forEach(({ parent, node }) => {
                                  const indexToRemove = parent.elements.indexOf(node);
                                  if (indexToRemove > -1) parent.elements.splice(indexToRemove, 1);
                                });

                                combinedText = '';
                                variableNodes = [];
                              }
                            }
                          }
                        });
                      }
                    });
                  }

                  if (node.elements) normalizeTextNodes(node.elements);
                });
              };

              // Función para reemplazar variables en el documento XML
              const replaceVariables = (nodes) => {
                nodes.forEach((node) => {
                  if (node.type === 'element' && node.name === 'w:t' && node.elements) {
                    let text = node.elements[0]?.text || '';
                    Object.entries(variables).forEach(([key, value]) => {
                      const regex = new RegExp(\`{{\s*\${key}\s*}}\`, 'g');
                      text = text.replace(regex, value);
                    });
                    text = text.replace(/{{.*?}}/g, ''); // Eliminar llaves residuales no reemplazadas
                    node.elements[0].text = text;
                  }
                  if (node.elements) replaceVariables(node.elements);
                });
              };

              // Función para crear una fila de tabla con bordes opcionales
              const createRow = (values, withBorders = true) => ({
                type: 'element',
                name: 'w:tr',
                elements: values.map((value) => ({
                  type: 'element',
                  name: 'w:tc',
                  elements: [
                    ...(withBorders
                      ? [
                          {
                            type: 'element',
                            name: 'w:tcPr',
                            elements: [
                              {
                                type: 'element',
                                name: 'w:tcBorders',
                                elements: [
                                  { name: 'w:top', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                                  { name: 'w:bottom', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                                  { name: 'w:left', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                                  { name: 'w:right', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                                ],
                              },
                            ],
                          },
                        ]
                      : []),
                    {
                      type: 'element',
                      name: 'w:p',
                      elements: [
                        {
                          type: 'element',
                          name: 'w:pPr', // Propiedades del párrafo
                          elements: [
                            {
                              type: 'element',
                              name: 'w:spacing',
                              attributes: {
                                'w:before': '150', // Margen superior de 200 twips (~0.14 pulgadas)
                              },
                            },
                          ],
                        },
                        {
                          type: 'element',
                          name: 'w:r',
                          elements: [
                            {
                              type: 'element',
                              name: 'w:t',
                              elements: [{ type: 'text', text: value }],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                })),
              });

              // Función para agregar bordes a una fila (encabezado)
              const addBordersToRow = (row) => {
                row.elements.forEach((cell) => {
                  if (cell.name === 'w:tc') {
                    if (!cell.elements) cell.elements = [];

                    // Buscar o crear propiedades de celda
                    let tcPr = cell.elements.find((el) => el.name === 'w:tcPr');
                    if (!tcPr) {
                      tcPr = { type: 'element', name: 'w:tcPr', elements: [] };
                      cell.elements.unshift(tcPr); // Agregar al inicio si no existe
                    }

                    // Verificar si ya existen bordes, si no, agregarlos
                    let tcBorders = tcPr.elements.find((el) => el.name === 'w:tcBorders');
                    if (!tcBorders) {
                      tcBorders = {
                        type: 'element',
                        name: 'w:tcBorders',
                        elements: [
                          { name: 'w:top', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                          { name: 'w:bottom', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                          { name: 'w:left', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                          { name: 'w:right', type: 'element', attributes: { 'w:val': 'single', 'w:sz': '4', 'w:space': '0', 'w:color': 'auto' } },
                        ],
                      };
                      tcPr.elements.push(tcBorders); // Agregar bordes a las propiedades
                    }
                  }
                });
              };

              // Función auxiliar para extraer textos de una fila
              const extractRowTexts = (rowNode) => {
                return rowNode.elements
                  .filter((child) => child.name === 'w:tc')
                  .map((cell) => {
                    const paragraphs = cell.elements?.filter((child) => child.name === 'w:p') || [];
                    let cellText = '';

                    paragraphs.forEach((p) => {
                      const runs = p.elements?.filter((child) => child.name === 'w:r') || [];
                      runs.forEach((run) => {
                        const textElement = run.elements?.find((child) => child.name === 'w:t');
                        if (textElement && textElement.elements && textElement.elements[0]) {
                          cellText += textElement.elements[0].text.trim();
                        }
                      });
                    });

                    return cellText || '';
                  });
              };

              // Función para reemplazar valores en las tablas
              const replaceTableValues = (nodes, tables) => {
                nodes.forEach((node) => {
                  if (node.type === 'element' && node.name === 'w:tbl') {
                    console.log("=== Tabla detectada ===");

                    tables.forEach(({ encabezado, cuerpo }) => {
                      // Extraer las filas de la tabla
                      const tableRows = node.elements.filter((child) => child.name === 'w:tr');
                      if (!tableRows.length) {
                        console.log("No se encontraron filas en la tabla.");
                        return;
                      }

                      // Validar si el encabezado coincide
                      const headerRow = tableRows[0]; // Primera fila de la tabla
                      const headerTexts = extractRowTexts(headerRow);

                      console.log("Encabezado encontrado en tabla:", headerTexts);
                      console.log("Encabezado esperado:", encabezado.flat());

                      // Función para calcular la distancia de Levenshtein
                      const levenshteinDistance = (a, b) => {
                        const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
                        for (let j = 1; j <= b.length; j++) matrix[0][j] = j;

                        for (let i = 1; i <= a.length; i++) {
                          for (let j = 1; j <= b.length; j++) {
                            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                            matrix[i][j] = Math.min(
                              matrix[i - 1][j] + 1,
                              matrix[i][j - 1] + 1,
                              matrix[i - 1][j - 1] + cost
                            );
                          }
                        }
                        return matrix[a.length][b.length];
                      };

                      // Función para limpiar el texto y calcular similitud
                      const areHeadersSimilar = (text1, text2, threshold = 2) => {
                        const normalize = (text) => text.replace(/[s​‌‍﻿]/g, '').toLowerCase();
                        const distance = levenshteinDistance(normalize(text1), normalize(text2));
                        return distance <= threshold; // Permite diferencias de hasta "threshold" caracteres
                      };

                      // Comparación con similitud flexible
                      const isMatchingTable = headerTexts.every((text, index) => {
                        const expectedHeader = encabezado.flat()[index] || '';
                        const isSimilar = areHeadersSimilar(text, expectedHeader);
                        console.log(\`Comparando: '\${text}' con '\${expectedHeader}' -> Similitud: \${isSimilar}\`);
                        return isSimilar;
                      });

                      if (isMatchingTable) {
                        console.log("La tabla coincide con el encabezado. Reemplazando filas...");

                        // Agregar bordes al encabezado original sin perder estilos
                        addBordersToRow(headerRow);

                        // Mantener el encabezado original modificado
                        const updatedRows = [headerRow];

                        // Generar las filas nuevas del cuerpo
                        cuerpo.forEach((rowValues) => {
                          const newRow = createRow(rowValues);
                          updatedRows.push(newRow);
                        });

                        // Reemplazar las filas antiguas con el encabezado y nuevas filas
                        node.elements = updatedRows;

                        console.log("Tabla actualizada correctamente.");
                      } else {
                        console.log("La tabla no coincide con el encabezado esperado. Se omite.");
                      }
                    });
                  }

                  // Procesar hijos recursivamente
                  if (node.elements) replaceTableValues(node.elements, tables);
                });
              };

              const replaceImageUrlsWithImages = async (zip) => {
                const documentPath = "word/document.xml";
                let documentXml = zip.files[documentPath].asText();

                // Convertir el documento en un objeto XML
                const parsedXml = xml2js(documentXml, { compact: false, spaces: 4 });

                // Función para encontrar un nodo ancestro específico
                let defaultWidthEMU = 990000; // Valor por defecto en EMU
            let cellWidthEMU = defaultWidthEMU; // Variable global para el ancho actual de la celda

            // Función para encontrar un nodo ancestro específico y obtener el ancho de la celda
            const findAncestorNode = (node, ancestorName) => {
              let currentNode = node;

              while (currentNode) {
                  if (currentNode.name === ancestorName) {
                      if (ancestorName === "w:tc") { // Detectar si estamos en una celda
                          const widthFound = findCellWidth(currentNode);
                          if (widthFound) return true;

                          // Si no encontramos el ancho, buscar en la primera celda de la columna
                          const columnWidth = findWidthInFirstColumnCell(currentNode);
                          if (columnWidth) {
                              cellWidthEMU = columnWidth;
                              return true;
                          }
                      }
                      return true; // Ancestro encontrado
                  }
                  currentNode = currentNode.parent; // Subir al nodo padre
              }

              console.warn(\`No se encontró el ancestro "\${ancestorName}" ni su ancho. Usando valor por defecto.\`);
              cellWidthEMU = defaultWidthEMU;
              return false;
            };

            // Función auxiliar para obtener el ancho directo de la celda
            const findCellWidth = (cellNode) => {
              const tcPr = cellNode.elements?.find(el => el.name === "w:tcPr");
              if (tcPr) {
                  const tcW = tcPr.elements?.find(el => el.name === "w:tcW");
                  if (tcW && tcW.attributes?.["w:w"]) {
                      const widthTwips = parseInt(tcW.attributes["w:w"], 10);
                      cellWidthEMU = widthTwips * 600; // Convertir twips a EMU
                      console.log(\`Ancho de celda encontrado: \${cellWidthEMU} EMU\`);
                      return true;
                  }
              }
              return false;
            };

            // Función auxiliar para buscar el ancho en la primera celda de la columna
            const findWidthInFirstColumnCell = (cellNode) => {
              const rowNode = cellNode.parent; // Nodo de fila actual (w:tr)
              const tableNode = rowNode?.parent; // Nodo de tabla (w:tbl)

              if (tableNode) {
                  const firstRow = tableNode.elements?.find(el => el.name === "w:tr"); // Primera fila
                  if (firstRow) {
                      const columnIndex = rowNode.elements.indexOf(cellNode); // Posición de la celda actual en su fila
                      const firstCell = firstRow.elements?.filter(el => el.name === "w:tc")[columnIndex]; // Celda correspondiente
                      if (firstCell) {
                          console.log(\`Buscando ancho en la primera celda de la columna en índice: \${columnIndex}\`);
                          const tcPr = firstCell.elements?.find(el => el.name === "w:tcPr");
                          const tcW = tcPr?.elements?.find(el => el.name === "w:tcW");
                          if (tcW && tcW.attributes?.["w:w"]) {
                              const widthTwips = parseInt(tcW.attributes["w:w"], 10);
                              return widthTwips * 600; // Convertir twips a EMU
                          }
                      }
                  }
              }
              return null;
            };

                // Procesar nodos recursivamente para buscar y reemplazar URLs con imágenes
                const processNodesForImages = async (nodes, parentNode = null) => {
                  for (const node of nodes) {
                      if (node && typeof node === "object") {
                          node.parent = parentNode; // Asignar referencia al nodo padre
                      }
                      if (parentNode) {
                      }
              
                      if (node.type === "element" && node.name === "w:t" && node.elements) {
                          const text = node.elements[0]?.text || "";
              
                          // Verificar si el nodo está dentro de una celda de tabla
                          const isInTableCell = findAncestorNode(node, "w:tc");
                          console.log(\`¿Está dentro de una celda de tabla?: \${isInTableCell}\`);
              
                          // Si el texto es una URL de imagen, realizar el reemplazo
                          if (isImageUrl(text)) {
                              console.log(\`Se detectó una URL de imagen: \${text}\`);
                              const imageKey = decodeURIComponent(text.split('.amazonaws.com/')[1]);
                              console.log("Clave decodificada de la imagen en S3:", imageKey);
              
                              // Obtener URL firmada de la imagen
                              const imageUrl = await getSignedUrl(bucketName, imageKey);
                              console.log(\`URL firmada para la imagen: \${imageUrl}\`);
              
                              // Descargar imagen y obtener sus dimensiones
                              const response = await fetch(imageUrl);
                              if (!response.ok) throw new Error(\`Error al descargar la imagen: \${imageUrl}\`);
                              const imageBuffer = await response.arrayBuffer();
                              const { width, height } = await sharp(Buffer.from(imageBuffer)).metadata();
              
                              // Agregar la imagen al documento
                              const imageName = \`\${Date.now()}.png\`;
                              await addImageToDocx(zip, imageUrl, imageName);
                              console.log(\`Imagen agregada a "word/media/\${imageName}"\`);
              
                              // Obtener ancho de la celda si está en tabla, de lo contrario usar default
                              const aspectRatio = height / width;
                              const newHeightEMU = Math.round(cellWidthEMU * aspectRatio);
              
                              console.log(\`Ajuste de imagen - Ancho: \${cellWidthEMU} EMU, Altura: \${newHeightEMU} EMU\`);
              
                              // Generar el ID de la relación para la imagen
                              const imageId = addImageRelationship(zip, imageName);
                              console.log("ID de relación generado:", imageId);
              
                              // Reemplazar el nodo con la imagen ajustada
                              node.name = "w:drawing";
                              node.elements = [
                                  {
                                      type: "element",
                                      name: "wp:inline",
                                      elements: [
                                          {
                                              type: "element",
                                              name: "wp:extent",
                                              attributes: { cx: cellWidthEMU, cy: newHeightEMU },
                                          },
                                          {
                                              type: "element",
                                              name: "wp:docPr",
                                              attributes: { id: imageId.replace("rId", ""), name: \`Picture \${imageName}\` },
                                          },
                                          {
                                              type: "element",
                                              name: "a:graphic",
                                              elements: [
                                                  {
                                                      type: "element",
                                                      name: "a:graphicData",
                                                      attributes: { uri: "http://schemas.openxmlformats.org/drawingml/2006/picture" },
                                                      elements: [
                                                          {
                                                              type: "element",
                                                              name: "pic:pic",
                                                              elements: [
                                                                  {
                                                                      type: "element",
                                                                      name: "pic:nvPicPr",
                                                                      elements: [
                                                                          { type: "element", name: "pic:cNvPr", attributes: { id: "0", name: \`Picture \${imageName}\` } },
                                                                          { type: "element", name: "pic:cNvPicPr" },
                                                                      ],
                                                                  },
                                                                  {
                                                                      type: "element",
                                                                      name: "pic:blipFill",
                                                                      elements: [
                                                                          { type: "element", name: "a:blip", attributes: { "r:embed": imageId } },
                                                                          { type: "element", name: "a:stretch", elements: [{ type: "element", name: "a:fillRect" }] },
                                                                      ],
                                                                  },
                                                                  {
                                                                      type: "element",
                                                                      name: "pic:spPr",
                                                                      elements: [
                                                                          {
                                                                              type: "element",
                                                                              name: "a:xfrm",
                                                                              elements: [
                                                                                  { type: "element", name: "a:off", attributes: { x: "0", y: "0" } },
                                                                                  { type: "element", name: "a:ext", attributes: { cx: cellWidthEMU, cy: newHeightEMU } },
                                                                              ],
                                                                          },
                                                                          { type: "element", name: "a:prstGeom", attributes: { prst: "rect" }, elements: [{ type: "element", name: "a:avLst" }] },
                                                                      ],
                                                                  },
                                                              ],
                                                          },
                                                      ],
                                                  },
                                              ],
                                          },
                                      ],
                                  },
                              ];
                              console.log(
                                  isInTableCell
                                      ? "La imagen está dentro de una celda de tabla y se ha ajustado."
                                      : "La imagen está fuera de una tabla y tiene el tamaño por defecto."
                              );
                          }
                      }
              
                      // Procesar nodos hijos de forma recursiva
                      if (node.elements) {
                          await processNodesForImages(node.elements, node);
                      }
                  }
              };

                console.log("=== Iniciando proceso de reemplazo de URLs por imágenes ===");
                // Agregar namespaces necesarios
                parsedXml.elements[0].attributes = {
                  ...parsedXml.elements[0].attributes,
                  "xmlns:a": "http://schemas.openxmlformats.org/drawingml/2006/main",
                  "xmlns:pic": "http://schemas.openxmlformats.org/drawingml/2006/picture"
                };
                await processNodesForImages(parsedXml.elements, null);
                console.log("=== Proceso de reemplazo de URLs por imágenes completado ===");

                // Guardar el XML actualizado para depuración
                const updatedXml = js2xml(parsedXml, { compact: false, spaces: 4 });
                //console.log("======>>>>>>>>Guardando XML modificado para depuración<<<<<<<<=======");
                //console.log(updatedXml);
                const fs = require("fs");
                fs.writeFileSync("document_debug.xml", updatedXml);
                console.log("Archivo 'document_debug.xml' guardado exitosamente.");

                // Actualizar el documento en el ZIP
                zip.file(documentPath, updatedXml);
            };
            
              // Procesar y reemplazar variables y tablas
              console.log("Procesando documento XML...");
              normalizeTextNodes(parsedXml.elements);
              replaceVariables(parsedXml.elements); // Reemplaza variables
              replaceTableValues(parsedXml.elements, tablas); // Reemplaza valores en tablas

              // Guardar el documento con las variables y tablas reemplazadas
              let updatedXml = js2xml(parsedXml, { compact: false, spaces: 4 });
              zip.file("word/document.xml", updatedXml);

              // Reemplazar URLs con imágenes en el documento actualizado
              console.log("Revisando y reemplazando imágenes en el documento...");
              await replaceImageUrlsWithImages(zip);

              const updatedBuffer = zip.generate({ type: 'nodebuffer' });
              const newKey = \`documents/generated/\${Date.now()}-generated.docx\`;
              const uploadResult = await uploadFile(bucketName, newKey, updatedBuffer);

              console.log("Documento generado con éxito:", uploadResult.Location);
              return uploadResult.Location;
            };
          `;

    console.log("=== Código generado ===");
    console.log(generatedCode);

    // Guardar la configuración y el código generado en la base de datos
    const insertQuery = `
      INSERT INTO document_configuration (template_id, configuration, generated_code, created_at, entity)
      VALUES ($1, $2, $3, NOW(), $4)
    `;

    const configuration = {
      variables,
      tablas,
    };

    await pool.query(insertQuery, [
      templateId,
      JSON.stringify(configuration),
      generatedCode,
      transformedEntity,
    ]);

    console.log("Configuración y código almacenados correctamente en la base de datos.");
    res.status(201).json({ message: 'Configuración guardada correctamente.' });
  } catch (error) {
    console.error("Error al almacenar la configuración:", error.message);
    res.status(500).json({ message: 'Error interno del servidor', error: error.message });
  }
});

// Ruta para ejecutar código dinámico almacenado
router.post('/create-document-client', async (req, res) => {
  const { idEntity, id } = req.body; // Recibir ID de la entidad e ID de configuración
  try {
    console.log("=== Iniciando ejecución de configuración almacenada ===");

    // Validar entradas requeridas
    if (!idEntity || !id) {
      return res.status(400).json({ message: "Los campos 'idEntity' y 'id' son obligatorios." });
    }

    console.log("ID de la entidad recibido:", idEntity);
    console.log("ID de configuración recibido:", id);

    // Consultar la configuración en la base de datos
    const query = 'SELECT generated_code FROM document_configuration WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Configuración no encontrada." });
    }

    const { generated_code } = result.rows[0];
    console.log("Código generado obtenido de la base de datos.");

    // Preparar el sandbox
    const sandbox = {
      console: console, // Permite console.log
      require: require, // Permite require
      idEntity: idEntity, // ID de la entidad
      pool: pool, // Conexión a la base de datos
      fetch: fetch, // Para descargar archivos desde S3
      PizZip: require('pizzip'), // Librería para manejar archivos .docx
      xml2js: require('xml-js').xml2js, // Parsear XML a JSON
      js2xml: require('xml-js').js2xml, // Convertir JSON a XML
      getSignedUrl: getSignedUrl, // Función para obtener URLs firmadas de S3
      uploadFile: uploadFile, // Función para subir archivos a S3
      bucketName: "fumiplagax", // Nombre del bucket S3
      Buffer: Buffer, // Agregar Buffer al sandbox
      sharp,
      moment,
    };    

     // Crear un script envolviendo el código generado en una función `async`
     const script = new vm.Script(`
      (async () => {
        ${generated_code}
        return await createDocument_clients(idEntity);
      })();
    `);

    const context = vm.createContext(sandbox);
    script.runInContext(context);

    console.log("Código ejecutado exitosamente.");

    res.status(200).json({ message: "Código ejecutado correctamente.", executed: true });
  } catch (error) {
    console.error("Error al ejecutar el código generado:", error.message);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

// Ruta para ejecutar código dinámico almacenado
router.post('/create-document-service', async (req, res) => {
  const { idEntity, id } = req.body; // Recibir ID de la entidad e ID de configuración
  try {
    console.log("=== Iniciando ejecución de configuración almacenada ===");

    // Validar entradas requeridas
    if (!idEntity || !id) {
      return res.status(400).json({ message: "Los campos 'idEntity' y 'id' son obligatorios." });
    }

    console.log("ID de la entidad recibido:", idEntity);
    console.log("ID de configuración recibido:", id);

    // Consultar la configuración en la base de datos
    const query = 'SELECT generated_code FROM document_configuration WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Configuración no encontrada." });
    }

    const { generated_code } = result.rows[0];
    console.log("Código generado obtenido de la base de datos.");

    // Preparar el sandbox
    const sandbox = {
      console: console, // Permite console.log
      require: require, // Permite require
      idEntity: idEntity, // ID de la entidad
      pool: pool, // Conexión a la base de datos
      fetch: fetch, // Para descargar archivos desde S3
      PizZip: require('pizzip'), // Librería para manejar archivos .docx
      xml2js: require('xml-js').xml2js, // Parsear XML a JSON
      js2xml: require('xml-js').js2xml, // Convertir JSON a XML
      getSignedUrl: getSignedUrl, // Función para obtener URLs firmadas de S3
      uploadFile: uploadFile, // Función para subir archivos a S3
      bucketName: "fumiplagax", // Nombre del bucket S3
      Buffer: Buffer, // Agregar Buffer al sandbox
      sharp,
      moment,
    };    

     // Crear un script envolviendo el código generado en una función `async`
     const script = new vm.Script(`
      (async () => {
        ${generated_code}
        return await createDocument_services(idEntity);
      })();
    `);

    const context = vm.createContext(sandbox);
    script.runInContext(context);

    console.log("Código ejecutado exitosamente.");

    res.status(200).json({ message: "Código ejecutado correctamente.", executed: true });
  } catch (error) {
    console.error("Error al ejecutar el código generado:", error.message);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

// Ruta para ejecutar código dinámico almacenado
router.post('/create-document-inspeccion', async (req, res) => {
  const { idEntity, id } = req.body; // Recibir ID de la entidad e ID de configuración
  try {
    console.log("=== Iniciando ejecución de configuración almacenada ===");

    // Validar entradas requeridas
    if (!idEntity || !id) {
      return res.status(400).json({ message: "Los campos 'idEntity' y 'id' son obligatorios." });
    }

    console.log("ID de la entidad recibido:", idEntity);
    console.log("ID de configuración recibido:", id);

    // Consultar la configuración en la base de datos
    const query = 'SELECT generated_code FROM document_configuration WHERE id = $1';
    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Configuración no encontrada." });
    }

    const { generated_code } = result.rows[0];
    console.log("Código generado obtenido de la base de datos.");

    // Preparar el sandbox
    const sandbox = {
      console: console, // Permite console.log
      require: require, // Permite require
      idEntity: idEntity, // ID de la entidad
      pool: pool, // Conexión a la base de datos
      fetch: fetch, // Para descargar archivos desde S3
      PizZip: require('pizzip'), // Librería para manejar archivos .docx
      xml2js: require('xml-js').xml2js, // Parsear XML a JSON
      js2xml: require('xml-js').js2xml, // Convertir JSON a XML
      getSignedUrl: getSignedUrl, // Función para obtener URLs firmadas de S3
      uploadFile: uploadFile, // Función para subir archivos a S3
      bucketName: "fumiplagax", // Nombre del bucket S3
      Buffer: Buffer, // Agregar Buffer al sandbox
      sharp,
      moment,
    };    

     // Crear un script envolviendo el código generado en una función `async`
     const script = new vm.Script(`
      (async () => {
        ${generated_code}
        return await createDocument_inspections(idEntity);
      })();
    `);

    const context = vm.createContext(sandbox);
    script.runInContext(context);

    console.log("Código ejecutado exitosamente.");

    res.status(200).json({ message: "Código ejecutado correctamente.", executed: true });
  } catch (error) {
    console.error("Error al ejecutar el código generado:", error.message);
    res.status(500).json({ message: "Error interno del servidor", error: error.message });
  }
});

module.exports = router;

//fin