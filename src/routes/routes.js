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

// Ruta para actualizar el perfil del usuario (datos y foto)
router.post('/updateProfile', uploadImage, async (req, res) => {
  const { name, lastname, email, phone, userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required' });
  }

  // Construye la URL de la imagen si se subió un archivo
  let imageUrl = null;
  if (req.file) {
    imageUrl = `/media/images/${req.file.filename}`;
  }  

  try {
    // Consulta para actualizar el perfil del usuario
    const query = `
      UPDATE users 
      SET name = $1, lastname = $2, email = $3, phone = $4, image = COALESCE($5, image) 
      WHERE id = $6
    `;
    const values = [name, lastname, email, phone, imageUrl, userId];
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
  // Agrega console.log para ver qué datos recibe el servidor
  console.log("Received body:", req.body);
  console.log("Received file:", req.file);

  const { id, name, lastname, rol, email, phone, password } = req.body;

  // Comprobación de campos obligatorios y log de error si falta alguno
  if (!id || !name || !lastname || !rol || !email || !phone || !password) {
    console.error("Missing fields:", { id, name, lastname, rol, email, phone, password });
    return res.status(400).json({ success: false, message: "All fields are required" });
  }

  // Construcción de la URL de la imagen si se subió un archivo
  let imageUrl = null;
  if (req.file) {
    imageUrl = `/media/images/${req.file.filename}`;
  }

  try {
    // Verifica si el usuario ya existe en la base de datos
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) {
      console.error("User already exists with email:", email);
      return res.status(400).json({ success: false, message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users (id, name, lastname, rol, email, phone, password, image) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [id, name, lastname, rol, email, phone, hashedPassword, imageUrl]
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
    const result = await pool.query('SELECT id, name, lastname, email, rol, image FROM users');
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
    const result = await pool.query('SELECT id, name, lastname, rol, email, phone, image FROM users WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error("Error al obtener usuario:", error);
    res.status(500).json({ message: 'Error al obtener el usuario' });
  }
});

// Crear cliente
router.post('/clients', async (req, res) => {
  const { name, address, phone, email, representative, document_type, document_number, contact_name, contact_phone, rut } = req.body;

  try {
    const query = `
      INSERT INTO clients (name, address, phone, email, representative, document_type, document_number, contact_name, contact_phone, rut)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
    `;
    const values = [name, address, phone, email, representative, document_type, document_number, contact_name, contact_phone, rut];
    const result = await pool.query(query, values);

    res.status(201).json({ success: true, message: "Client created successfully", client: result.rows[0] });
  } catch (error) {
    console.error("Error creating client:", error);
    res.status(500).json({ success: false, message: "Server error" });
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
  const { name, address, phone, email, representative, document_type, document_number, contact_name, contact_phone, rut } = req.body;

  try {
    const query = `
      UPDATE clients
      SET name = $1, address = $2, phone = $3, email = $4, representative = $5, document_type = $6, document_number = $7,
          contact_name = $8, contact_phone = $9, rut = $10
      WHERE id = $11 RETURNING *
    `;
    const values = [name, address, phone, email, representative, document_type, document_number, contact_name, contact_phone, rut, id];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Client not found" });
    }
    res.json({ success: true, message: "Client updated successfully", client: result.rows[0] });
  } catch (error) {
    console.error("Error updating client:", error);
    res.status(500).json({ success: false, message: "Server error" });
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
  const { service_type, description, pest_to_control, intervention_areas, responsible, category, quantity_per_month, client_id, value, companion, created_by } = req.body;

  try {
    const query = `
      INSERT INTO services (service_type, description, pest_to_control, intervention_areas, responsible, category, quantity_per_month, client_id, value, companion, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *
    `;
    const values = [service_type, description, pest_to_control, intervention_areas, responsible, category, quantity_per_month, client_id, value, companion, created_by];
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
  const { service_type, description, pest_to_control, intervention_areas, responsible, category, quantity_per_month, client_id, value, companion, created_by } = req.body;

  try {
    const query = `
      UPDATE services
      SET service_type = $1, description = $2, pest_to_control = $3, intervention_areas = $4, responsible = $5, category = $6,
          quantity_per_month = $7, client_id = $8, value = $9, companion = $10, created_by = $11
      WHERE id = $12 RETURNING *
    `;
    const values = [service_type, description, pest_to_control, intervention_areas, responsible, category, quantity_per_month, client_id, value, companion, created_by, id];
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

// Eliminar servicio
router.delete('/services/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM services WHERE id = $1 RETURNING *', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Service not found" });
    }
    res.json({ success: true, message: "Service deleted successfully" });
  } catch (error) {
    console.error("Error deleting service:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});


module.exports = router;