const axios = require('axios');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const sharp = require('sharp');
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
    inspección: 'inspections',
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

                console.log("Datos de la entidad 'stations' obtenidos:", stationsData);
                console.log("Datos de la entidad 'client_maps' obtenidos:", clientMapsData);

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

                // Procesar variables
                Object.entries(variables).forEach(([key, value]) => {
                  if (value.startsWith("Cliente-")) {
                    const field = value.split('-')[1];
                    variables[key] = updateValue(clientData, field, "clients");
                  } else if (value.startsWith("Mapas-")) {
                    const field = value.split('-')[1];
                    variables[key] = clientMapsData[0] ? updateValue(clientMapsData[0], field, "client_maps") : "No encontrado";
                  } else if (value.startsWith("Estaciones Aéreas-") || value.startsWith("Estaciones Roedores-")) {
                    const field = value.split('-')[1];
                    variables[key] = stationsData[0] ? updateValue(stationsData[0], field, "stations") : "No encontrado";
                  }
                });

                console.log("Variables actualizadas después de las consultas:", variables);

                // Procesar tablas
                tablas.forEach((tabla) => {
                  console.log(\`\\n=== Procesando tabla: \${tabla.nombre} ===\`);
                  tabla.cuerpo = tabla.cuerpo.map((row) =>
                    row.map((field) => {
                      if (field.startsWith("Cliente-")) {
                        const clientField = field.split('-')[1];
                        return updateValue(clientData, clientField, "clients");
                      } else if (field.startsWith("Mapas-")) {
                        const mapField = field.split('-')[1];
                        return clientMapsData[0] ? updateValue(clientMapsData[0], mapField, "client_maps") : "No encontrado";
                      } else if (field.startsWith("Estaciones Aéreas-") || field.startsWith("Estaciones Roedores-")) {
                        const stationField = field.split('-')[1];
                        return stationsData[0] ? updateValue(stationsData[0], stationField, "stations") : "No encontrado";
                      } else {
                        return field; // Mantener valor original si no coincide con ningún prefijo
                      }
                    })
                  );
                  console.log(\`Tabla "\${tabla.nombre}" actualizada:\`, tabla.cuerpo);
                });
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
              console.log(\`Iniciando búsqueda de ancestro "\${ancestorName}" para el nodo actual: \${node.name}\`);

              while (currentNode) {
                  console.log(\`Revisando ancestro: \${currentNode.name}\`);
                  if (currentNode.name === ancestorName) {
                      if (ancestorName === "w:tc") { // Detectar si estamos en una celda
                          const widthFound = findCellWidth(currentNode);
                          if (widthFound) return true;

                          // Si no encontramos el ancho, buscar en la primera celda de la columna
                          const columnWidth = findWidthInFirstColumnCell(currentNode);
                          if (columnWidth) {
                              cellWidthEMU = columnWidth;
                              console.log(\`Ancho de la primera celda de la columna asignado: \${cellWidthEMU} EMU\`);
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
              
                      console.log(\`Procesando nodo: <\${node.name}>\`);
                      if (parentNode) {
                          console.log(\`Nodo padre inmediato: <\${parentNode.name}>\`);
                      }
              
                      if (node.type === "element" && node.name === "w:t" && node.elements) {
                          const text = node.elements[0]?.text || "";
                          console.log(\`Contenido del nodo <w:t>: "\${text}"\`);
              
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
                console.log("======>>>>>>>>Guardando XML modificado para depuración<<<<<<<<=======");
                console.log(updatedXml);
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

module.exports = router;