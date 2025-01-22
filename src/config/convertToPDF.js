const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");

const tempDirectory = path.join(__dirname, "../../public/media/documents");

// Convertir un archivo a PDF usando soffice (LibreOffice)
const convertToPDF = async (inputBuffer) => {
  if (!fs.existsSync(tempDirectory)) {
    fs.mkdirSync(tempDirectory, { recursive: true });
  }

  const tempInputPath = path.join(tempDirectory, `${Date.now()}.docx`);
  const tempOutputPath = tempInputPath.replace(".docx", ".pdf");

  // Escribir el archivo temporalmente
  fs.writeFileSync(tempInputPath, inputBuffer);

  return new Promise((resolve, reject) => {
    const command = `soffice --headless --convert-to pdf "${tempInputPath}" --outdir "${tempDirectory}"`;
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error("Error ejecutando el comando de LibreOffice:", error.message);
        console.error("Salida estándar:", stdout);
        console.error("Error estándar:", stderr);
        fs.unlinkSync(tempInputPath);
        return reject(error);
      }

      try {
        const pdfBuffer = fs.readFileSync(tempOutputPath);
        fs.unlinkSync(tempInputPath);
        fs.unlinkSync(tempOutputPath);
        resolve(pdfBuffer);
      } catch (readError) {
        console.error("Error leyendo el archivo PDF generado:", readError.message);
        fs.unlinkSync(tempInputPath);
        reject(readError);
      }
    });
  });
};

module.exports = { convertToPDF };
