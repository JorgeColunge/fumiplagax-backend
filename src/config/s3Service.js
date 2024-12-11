const AWS = require('aws-sdk');
const s3 = new AWS.S3({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Subir un archivo a S3
const uploadFile = async (bucketName, key, fileContent) => {
    const params = {
        Bucket: bucketName,
        Key: key,
        Body: fileContent,
        ACL: 'private', // Cambiar a 'public-read' si necesitas acceso público
    };
    return await s3.upload(params).promise();
};

// Obtener un enlace prefirmado para descargar un archivo
const getSignedUrl = async (bucketName, key) => {
    const params = {
        Bucket: bucketName,
        Key: key,
        Expires: 60, // Tiempo de expiración en segundos
    };
    return s3.getSignedUrlPromise('getObject', params);
};

// Eliminar un archivo de S3
const deleteObject = async (bucketName, key) => {
    const params = {
        Bucket: bucketName,
        Key: key,
    };
    return s3.deleteObject(params).promise();
};

module.exports = { uploadFile, getSignedUrl, deleteObject };
