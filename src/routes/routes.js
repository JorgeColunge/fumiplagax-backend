const axios = require('axios');
const express = require('express');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const router = express.Router();
const pool = require('../config/dbConfig');

// Configuración de almacenamiento con Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '..', '..', 'public', 'media', 'images'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

// Definición de fileFilter para permitir solo imágenes (jpeg, jpg, png, gif)
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

const uploadImage = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }
}).single('image'); // Cambiamos `.fields` por `.single`

router.post('/updateProfile', uploadImage, async (req, res) => {
  const { name, lastname, email, phone, userId, color } = req.body;

  let imageUrl = null;
  if (req.file) {
    imageUrl = `/media/images/${req.file.filename}`;
  }

  try {
    // Construir partes dinámicas para la consulta
    const fields = [];
    const values = [];
    let index = 1;

    if (name) {
      fields.push(`name = $${index++}`);
      values.push(name);
    }
    if (lastname) {
      fields.push(`lastname = $${index++}`);
      values.push(lastname);
    }
    if (email) {
      fields.push(`email = $${index++}`);
      values.push(email);
    }
    if (phone) {
      fields.push(`phone = $${index++}`);
      values.push(phone);
    }
    if (color) {
      fields.push(`color = $${index++}`);
      values.push(color);
    }
    if (imageUrl) {
      fields.push(`image = $${index++}`);
      values.push(imageUrl);
    }

    // Agregar el userId como condición al final
    values.push(userId);

    // Verificar si hay campos para actualizar
    if (fields.length === 0) {
      return res.status(400).json({ message: 'No se enviaron datos para actualizar' });
    }

    // Construir consulta SQL dinámica
    const query = `
      UPDATE users 
      SET ${fields.join(', ')}
      WHERE id = $${index}
    `;

    // Ejecutar consulta
    await pool.query(query, values);

    res.json({ message: 'Perfil actualizado exitosamente', profilePicURL: imageUrl });
  } catch (error) {
    console.error("Error updating profile:", error);
    res.status(500).json({ message: 'Error al actualizar el perfil' });
  }
});

// Ruta para subir y almacenar la URL de la imagen (sin actualizar otros datos)
router.post('/upload', (req, res) => {
  uploadImage(req, res, async (err) => {
    if (err) {
      console.error("Error uploading image:", err.message);
      return res.status(400).json({ message: err.message });
    }

    const userId = req.body.userId;
    console.log("Received User ID:", userId);

    if (!userId) {
      console.error("User ID is missing in request");
      return res.status(400).json({ message: 'User ID is required to upload the image.' });
    }

    if (!req.file) {
      console.error("No file found after upload");
      return res.status(400).json({ message: "No file uploaded" });
    }

    const imageUrl = `/media/images/${req.file.filename}`;
    try {
      const updateQuery = 'UPDATE users SET image = $1 WHERE id = $2';
      const values = [imageUrl, userId];
      await pool.query(updateQuery, values);

      console.log("Image URL stored in database for user:", userId);
      res.json({ profilePicURL: imageUrl, message: 'Imagen subida y URL almacenada correctamente' });
    } catch (dbError) {
      console.error("Error updating database:", dbError);
      res.status(500).json({ message: 'Error storing image URL in database' });
    }
  });
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

router.post('/register', uploadImage, async (req, res) => {
  console.log("Received body:", req.body);
  console.log("Received file:", req.file);

  const { id, name, lastname, rol, email, phone, password, color } = req.body;

  if (!id || !name || !lastname || !rol || !email || !phone || !password) {
    console.error("Missing fields:", { id, name, lastname, rol, email, phone, password });
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  let imageUrl = null;
  if (req.file) {
    imageUrl = `/media/images/${req.file.filename}`;
  }

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      console.error("User already exists with email:", email);
      return res.status(400).json({ success: false, message: "User already exists" });
    }

    // Genera la contraseña encriptada
    const hashedPassword = await bcrypt.hash(password, 10);

    // Función para generar colores vibrantes aleatorios
    const getVibrantColor = () => {
      const r = Math.floor(Math.random() * 156) + 100; // Rojo (100-255)
      const g = Math.floor(Math.random() * 156) + 100; // Verde (100-255)
      const b = Math.floor(Math.random() * 156) + 100; // Azul (100-255)
      return `rgb(${r}, ${g}, ${b})`;
    };

    await pool.query(
      'INSERT INTO users (id, name, lastname, rol, email, phone, password, image, color) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [id, name, lastname, rol, email, phone, hashedPassword, imageUrl, color ? color : getVibrantColor()]
    );

    res.json({ success: true, message: "User registered successfully", profilePicURL: imageUrl });
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Nueva ruta para obtener todos los usuarios registrados
router.get('/users', async (req, res) => {
  try {
    // Selecciona los campos que deseas devolver, por ejemplo: id, nombre, apellido, email, rol
    const result = await pool.query('SELECT * FROM users');
    res.json(result.rows); // Enviar la lista de usuarios como JSON
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
    res.json(result.rows[0]);
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

const fs = require('fs'); // Añadir esto al inicio para manejar el sistema de archivos

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
      title: `Servicio ${service_id}`,
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
    res.json(result.rows);
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
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error fetching station:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Crear una nueva estación
router.post('/stations', async (req, res) => {
  const { description, category, type, control_method, client_id, qr_code } = req.body;

  try {
    const adjustedQrCode = qr_code === '' ? null : qr_code; // Convertir cadena vacía a NULL

    const query = `
      INSERT INTO stations (description, category, type, control_method, client_id, qr_code)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
    `;
    const values = [description, category, type, control_method, client_id, adjustedQrCode];
    const result = await pool.query(query, values);

    res.status(201).json({ success: true, station: result.rows[0] });
  } catch (error) {
    console.error('Error creating station:', error);
    res.status(500).json({ success: false, message: 'Error creating station', error: error.message });
  }
});


// Actualizar una estación existente
router.put('/stations/:id', async (req, res) => {
  const { id } = req.params;
  const { description, category, type, control_method, client_id, qr_code } = req.body;

  try {
    const query = `
      UPDATE stations
      SET description = $1, category = $2, type = $3, control_method = $4, client_id = $5, qr_code = $6
      WHERE id = $7 RETURNING *
    `;
    const values = [description, category, type, control_method, client_id, qr_code, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Station not found" });
    }

    res.json({ success: true, message: "Station updated successfully", station: result.rows[0] });
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

    res.json(result.rows);
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

module.exports = router;