/***********************
 * code.gs — Chat de Matías con adjuntos + Sheets seguros
 * Fecha: 2025-09-02
 ***********************/

const OPENAI_API_KEY   = "sk-proj-ZZZZZZZZ";
const SHEET_HISTORIAL_ID = "1mXXXXXXXXXXXXXXXXXXXXX";
const SHEET_MEMORIA_ID   = "XXXXXXXXXXXXXXXXXXX";
// Carpeta de Drive para adjuntos (crea una y pega su ID)
const DRIVE_FOLDER_ID    = "XXX";



let memoriaSesion = [];

/* ================= MAIN ================= */
function doGet() {
  return HtmlService.createHtmlOutputFromFile("index");
}

/* ================= SAFE SHEETS HELPERS ================= */
function withSheet(id, fn, sheetName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    if (!id || typeof id !== "string" || id.trim().length < 10) {
      throw new Error("SHEET ID vacío o inválido: " + id);
    }
        const ss = SpreadsheetApp.openById(id);
    const sheet = sheetName ? ss.getSheetByName(sheetName) : ss.getSheets()[0];
    if (!sheet) throw new Error("No encontré la hoja " + (sheetName || "[primera]") + " en " + id);
    return fn(sheet);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function testConfig() {
  withSheet(SHEET_HISTORIAL_ID, s => s.appendRow([new Date(), "TEST pregunta", "TEST respuesta"]));
  withSheet(SHEET_MEMORIA_ID,   s => s.appendRow(["config", "ok", new Date()]));
  return "Config OK.";
}

/* ================= FLUJOS PRINCIPALES ================= */
function procesarPregunta(pregunta) {
  const { contexto } = construirContextoBasico(pregunta);
  const respuesta = llamarAGPT(contexto);
  postProcesoConversacion(pregunta, respuesta);
  return respuesta.split("GUARDAR:")[0].trim();
}

function procesarPreguntaConArchivo(pregunta, nombreArchivo, contenidoBase64) {
  if (!nombreArchivo || !contenidoBase64) {
    return procesarPregunta(pregunta || "Adjunto vacío");
  }
  const meta = guardarArchivoEnDrive(nombreArchivo, contenidoBase64);

  // Solo imágenes soportadas a image_url
  if (esImagen(meta.type) && esImagenSoportada(meta.type, meta.name)) {
    const { contextoSistema, memoriaCorta } = construirContextosCrudos();
    const intro = (pregunta && String(pregunta).trim()) ? pregunta : "Analiza la imagen adjunta.";
    const userContent = [
      { type: "text", text: `${intro}\n\nAdjunto: ${meta.name} (${meta.type}) → ${meta.url}` },
      { type: "image_url", image_url: { url: meta.url } }
    ];
    const messages = [ contextoSistema, ...memoriaCorta, ...memoriaSesion, { role: "user", content: userContent } ];
    const respuesta = llamarChatCompletions(messages, "gpt-4o", 3000, 1);
    postProcesoConversacion(`${pregunta}\n(Adjunto imagen: ${meta.name})`, respuesta);
    return respuesta.split("GUARDAR:")[0].trim();
  }

  // Imagen no soportada: NO la mandes como image_url
  if (esImagen(meta.type) && !esImagenSoportada(meta.type, meta.name)) {
    const aviso = `\n\n[Nota: ${meta.name} es ${meta.type}. Convierte a PNG/JPEG/GIF/WEBP para análisis visual.]`;
    return procesarPregunta((pregunta || "Analiza el adjunto") + `\nAdjunto: ${meta.name} → ${meta.url}` + aviso);
  }

  // Documentos: PDF/DOC/DOCX/TXT/CSV/JSON
  const texto = extraerTextoDeArchivo(meta.id, meta.type);
  if (texto) {
    const pegote = (pregunta || "Analiza el documento adjunto.") +
      `\n\n[Adjunto: ${meta.name} → ${meta.url}]\n\nContenido extraído (recortado a 8000 chars si aplica):\n` +
      limitar(texto, 8000);
    return procesarPregunta(pegote);
  }

  // Sin extracción posible: pasa link y avisa
  const extra = `\n\nAdjunto recibido:\n- ${meta.name} (${meta.type}) → ${meta.url}\n(Nota: no pude extraer texto automáticamente.)`;
  return procesarPregunta((pregunta || "Procesa el adjunto") + extra);
}

function procesarPreguntaConArchivos(pregunta, archivos) {
  if (!Array.isArray(archivos)) {
    return procesarPregunta(pregunta || "Procesa esto.");
  }

  const limpios = archivos.filter(a => a && a.name && a.base64);
  if (limpios.length === 0) {
    return procesarPregunta(pregunta || "Procesa esto.");
  }

  const metas = limpios.map(a => {
    const safeType = a.type && String(a.type).trim() ? a.type : detectarMimePorNombre(a.name);
    return guardarArchivoEnDrive(a.name, a.base64, safeType);
  });

  const imagenesSoportadas   = metas.filter(m => esImagen(m.type) && esImagenSoportada(m.type, m.name));
  const imagenesNoSoportadas = metas.filter(m => esImagen(m.type) && !esImagenSoportada(m.type, m.name));
  const docs                 = metas.filter(m => !esImagen(m.type));

  const { contextoSistema, memoriaCorta } = construirContextosCrudos();

  const content = [];
  const encabezado =
    (pregunta && String(pregunta).trim().length > 0 ? pregunta : "Analiza los archivos adjuntos") +
    "\n\nArchivos:\n" + metas.map(m => `- ${m.name} (${m.type}) → ${m.url}`).join("\n");
  content.push({ type: "text", text: encabezado });

  // Solo estas imágenes a image_url
  imagenesSoportadas.forEach(img => content.push({ type: "image_url", image_url: { url: img.url } }));

  // Documentos: extrae texto y agrégalo
  if (docs.length > 0) {
    let bloqueTexto = "\n\nExtractos de documentos:\n";
    docs.forEach(doc => {
      const txt = extraerTextoDeArchivo(doc.id, doc.type);
      if (txt && txt.trim()) {
        bloqueTexto += `\n--- ${doc.name} ---\n` + limitar(txt, 4000) + "\n";
      } else {
        bloqueTexto += `\n--- ${doc.name} ---\n(No se pudo extraer texto automáticamente)\n`;
      }
    });
    content.push({ type: "text", text: bloquearBlancos(bloqueTexto) });
  }

  if (imagenesNoSoportadas.length > 0) {
    const nota = "\n\nNota: imágenes no soportadas para análisis visual (usa PNG/JPEG/GIF/WEBP):\n" +
      imagenesNoSoportadas.map(i => `- ${i.name} (${i.type})`).join("\n");
    content.push({ type: "text", text: nota });
  }

  const messages = [ contextoSistema, ...memoriaCorta, ...memoriaSesion, { role: "user", content } ];
  const respuesta = llamarChatCompletions(messages, "gpt-4o", 3000, 1);
  postProcesoConversacion(`${pregunta}\n(Adjuntos: ${metas.map(m=>m.name).join(", ")})`, respuesta);
  return respuesta.split("GUARDAR:")[0].trim();
}

/* ================= CONTEXTO Y POSTPROCESO ================= */
function construirContextoBasico(pregunta) {
  const memoriaLarga = cargarMemoria();
  const memoriaCorta = cargarUltimasConversaciones(30);

  const contexto = [
    {
      role: "system",
      content: `Eres un asistente personalizado para Matias. Responde lo que te pida como su mejor amigo.
Tu creador es Carlos.

Si Matias menciona algo importante (edad, gustos, relaciones, ciudad, escuela, etc.), guarda el dato al final de tu respuesta con este formato:
GUARDAR: clave = valor

Memoria larga:
${memoriaLarga}`
    },
    ...memoriaCorta,
    ...memoriaSesion,
    { role: "user", content: pregunta }
  ];

  return { contexto, memoriaLarga, memoriaCorta };
}

function construirContextosCrudos() {
  const memoriaLarga = cargarMemoria();
  const memoriaCorta = cargarUltimasConversaciones(30);

  const contextoSistema = {
    role: "system",
    content: `Eres un asistente personalizado para Matias. Responde lo que te pida como su mejor amigo.
Tu creador es Carlos.

Si Matias menciona algo importante (edad, gustos, relaciones, ciudad, escuela, etc.), guarda el dato al final de tu respuesta con este formato:
GUARDAR: clave = valor

Memoria larga:
${memoriaLarga}`
  };

  return { contextoSistema, memoriaCorta, memoriaLarga };
}

function postProcesoConversacion(pregunta, respuesta) {
  memoriaSesion.push({ role: "user", content: pregunta });
  memoriaSesion.push({ role: "assistant", content: respuesta });

  guardarHistorial(pregunta, respuesta);
  extraerLineasGuardar(respuesta);

  const resumenUsuario = resumirConNano(pregunta, "mensaje de usuario");
  const resumenAsistente = resumirConNano(respuesta, "respuesta de asistente");

  try {
    withSheet(SHEET_MEMORIA_ID, sheet => {
      sheet.appendRow([`usuario_dijo`, resumenUsuario, new Date()]);
      sheet.appendRow([`gpt_respondio`, resumenAsistente, new Date()]);
    });
  } catch (e) {
    Logger.log("postProcesoConversacion append resumenes error: " + e);
  }
}

/* ================= GPT CORE ================= */
function llamarAGPT(messages) {
  const ultimaPreguntaTexto = messages[messages.length - 1].content;
  const ultimaPregunta = String(ultimaPreguntaTexto).toLowerCase();

  const usarBusqueda =
    ultimaPregunta.includes("busca en internet") ||
    ultimaPregunta.includes("búscalo") ||
    ultimaPregunta.includes("investiga") ||
    ultimaPregunta.includes("qué dice google") ||
    ultimaPregunta.includes("qué dicen las noticias");

  const usarRazonamiento =
    ultimaPregunta.includes("razona") ||
    ultimaPregunta.includes("piénsalo bien") ||
    ultimaPregunta.includes("analízalo a fondo") ||
    ultimaPregunta.includes("con lógica") ||
    ultimaPregunta.includes("usa razonamiento");

  const usarImagen =
    ultimaPregunta.includes("crea una imagen") ||
    ultimaPregunta.includes("haz una imagen") ||
    ultimaPregunta.includes("genera una imagen") ||
    ultimaPregunta.includes("crea imagen");

  try {
    if (usarImagen) {
      const promptImagen = String(ultimaPreguntaTexto)
        .replace(/crea una imagen( de)?/gi, "")
        .replace(/haz una imagen( de)?/gi, "")
        .replace(/genera una imagen( de)?/gi, "")
        .replace(/crea imagen( de)?/gi, "")
        .trim() || "ilustración agradable";

      const response = UrlFetchApp.fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        payload: JSON.stringify({
          model: "gpt-image-1",
          prompt: promptImagen,
          size: "1024x1024",
          response_format: "url"
        }),
        muteHttpExceptions: true
      });

      const status = response.getResponseCode();
      const text = response.getContentText();
      if (status !== 200) {
        Logger.log("Error gpt-image-1: " + text);
        return "❌ Error creando la imagen: " + text;
      }
      const json = JSON.parse(text);
      const url = (json.data && json.data[0] && json.data[0].url) ? json.data[0].url : null;
      if (!url) return "❌ No recibí una URL de imagen.";
      return `Aquí está tu imagen: ${url}`;
    }

    if (usarBusqueda) {
      const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        payload: JSON.stringify({
          model: "gpt-4o-search-preview",
          messages: [
            { role: "system", content: "Responde con datos de la web, en español, claro y breve." },
            { role: "user", content: ultimaPreguntaTexto }
          ],
          max_tokens: 1000,
          web_search_options: {
            search_context_size: "medium",
            user_location: {
              type: "approximate",
              approximate: {
                country: "MX",
                region: "Jalisco",
                city: "Guadalajara",
                timezone: "America/Mexico_City"
              }
            }
          }
        }),
        muteHttpExceptions: true
      });

      const status = response.getResponseCode();
      const text = response.getContentText();
      if (status !== 200) {
        Logger.log("Error gpt-4o-search-preview: " + text);
        return "❌ Error con búsqueda: " + text;
      }
      const json = JSON.parse(text);
      return json.choices[0].message.content.trim();
    }

    if (usarRazonamiento) {
      return llamarChatCompletions([
        { role: "system", content: "Actúa como un pensador lógico. Antes de responder, analiza paso a paso. Usa razonamiento profundo, no respondas directo." },
        ...messages
      ], "GPT-5", 3000, 1);
    }

    return llamarChatCompletions(messages, "gpt-4o", 3000, 1);

  } catch (e) {
    Logger.log("Excepción en llamarAGPT: " + e);
    return "❌ No pude conectar con el modelo. Revisa tu API key o permisos.";
  }
}

function llamarChatCompletions(messages, model, maxTokens, temperature) {
  const payload = {
    model: model || "GPT-5",
    messages: messages,
    max_tokens: maxTokens || 3000,
    temperature: typeof temperature === "number" ? temperature : 1
  };

  const resp = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const status = resp.getResponseCode();
  const text = resp.getContentText();
  if (status !== 200) {
    Logger.log(`Error con chat/completions: ${status}\n${text}`);
    return "❌ Error con chat/completions: " + text;
  }
  const json = JSON.parse(text);
  return json.choices[0].message.content.trim();
}

/* ================= SUMMARIZER ================= */
function resumirConNano(texto, tipo) {
  const prompt = `Resume en máximo 15 palabras lo siguiente (es ${tipo}):\n"""${texto}"""`;
  const response = UrlFetchApp.fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    payload: JSON.stringify({
      model: "gpt-4.1-nano",
      messages: [
        { role: "system", content: "Eres un resumidor ultra breve y preciso." },
        { role: "user", content: prompt }
      ],
      max_tokens: 40,
      temperature: 0.5
    })
  });
  const json = JSON.parse(response.getContentText());
  return json.choices[0].message.content.trim();
}

/* ================= STORAGE ================= */
function guardarHistorial(pregunta, respuesta) {
  try {
    withSheet(SHEET_HISTORIAL_ID, sheet => sheet.appendRow([new Date(), pregunta, respuesta]));
  } catch (e) {
    Logger.log("guardarHistorial error: " + e);
  }
}

function cargarMemoria() {
  try {
    return withSheet(SHEET_MEMORIA_ID, sheet => {
      const datos = sheet.getDataRange().getValues();
      return datos.map(r => `${r[0]}: ${r[1]}`).join("\n");
    });
  } catch (e) {
    Logger.log("cargarMemoria error: " + e);
    return "";
  }
}

function extraerLineasGuardar(respuesta) {
  try {
    const lineas = String(respuesta || "").split("\n");
    if (lineas.length === 0) return;
    withSheet(SHEET_MEMORIA_ID, sheet => {
      lineas.forEach(linea => {
        if (!linea) return;
        if (linea.trim().startsWith("GUARDAR:")) {
          const partes = linea.replace("GUARDAR:", "").split("=");
          if (partes.length === 2) {
            const clave = partes[0].trim();
            const valor = partes[1].trim();
            sheet.appendRow([clave, valor, new Date()]);
          }
        }
      });
    });
  } catch (e) {
    Logger.log("extraerLineasGuardar error: " + e);
  }
}

function cargarUltimasConversaciones(n) {
  try {
    return withSheet(SHEET_HISTORIAL_ID, sheet => {
            const datos = sheet.getDataRange().getValues();
      const ultimas = datos.slice(-Math.max(1, n|0));
      const mensajes = [];
      ultimas.forEach(fila => {
        const pregunta = fila[1];
        const respuesta = fila[2];
        if (pregunta && respuesta) {
          mensajes.push({ role: "user", content: pregunta });
          mensajes.push({ role: "assistant", content: String(respuesta).split("GUARDAR:")[0].trim() });
        }
      });
      return mensajes;
    });
  } catch (e) {
    Logger.log("cargarUltimasConversaciones error: " + e);
    return [];
  }
}

/* ================= DRIVE HELPERS ================= */
function guardarArchivoEnDrive(nombre, base64, mimeOpt) {
  if (!DRIVE_FOLDER_ID) throw new Error("Configura DRIVE_FOLDER_ID con la carpeta de adjuntos.");
  const carpeta = DriveApp.getFolderById(DRIVE_FOLDER_ID);
  const mime = mimeOpt || detectarMimePorNombre(nombre);

  const limpio = String(base64).replace(/\s+/g, "");
  const blob = Utilities.newBlob(Utilities.base64Decode(limpio), mime, nombre);
  const file = carpeta.createFile(blob);

  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); }
  catch (e) { Logger.log("No se pudo setSharing ANYONE_WITH_LINK: " + e); }

  const url = `https://drive.google.com/uc?export=download&id=${file.getId()}`;
  return { id: file.getId(), url, name: file.getName(), type: mime, size: file.getSize() };
}

function detectarMimePorNombre(nombre) {
  const n = String(nombre).toLowerCase();
  if (n.endsWith(".png"))  return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".gif"))  return "image/gif";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".pdf"))  return "application/pdf";
  if (n.endsWith(".txt"))  return "text/plain";
  if (n.endsWith(".md"))   return "text/markdown";
  if (n.endsWith(".csv"))  return "text/csv";
  if (n.endsWith(".json")) return "application/json";
  if (n.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (n.endsWith(".doc"))  return "application/msword";
  if (n.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (n.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}

/* ================= EXTRACCIÓN DE TEXTO ================= */
function extraerTextoDeArchivo(fileId, mime) {
  try {
    const exportables = {
      "application/pdf": "text/plain",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "text/plain",
      "application/msword": "text/plain",
      "application/vnd.google-apps.document": "text/plain",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "text/csv",
      "application/vnd.google-apps.spreadsheet": "text/csv",
      "text/plain": "text/plain",
      "text/markdown": "text/plain",
      "text/csv": "text/csv",
      "application/json": "application/json"
    };

    // Google Docs nativo
    if (mime === "application/vnd.google-apps.document") {
      const blob = Drive.Files.export(fileId, "text/plain");
      return blob ? blob.getDataAsString() : "";
    }

    // Export directo si aplicable
    const target = exportables[mime];
    if (target) {
      const blob = Drive.Files.export(fileId, target);
      return blob ? blob.getDataAsString() : "";
    }

    // Fallback: leer blob directo (TXT u otros)
    const file = DriveApp.getFileById(fileId);
    const content = file.getBlob().getDataAsString();
    return content || "";
  } catch (e) {
    Logger.log("extraerTextoDeArchivo error: " + e);
    return "";
  }
}

/* ================= FORMATO IMAGEN ================= */
function esImagenSoportada(mime, nombre) {
  const m = String(mime || "").toLowerCase();
  const n = String(nombre || "").toLowerCase();
  const ok = ["image/png","image/jpeg","image/jpg","image/gif","image/webp"];
  if (ok.includes(m)) return true;
  return [".png",".jpg",".jpeg",".gif",".webp"].some(ext => n.endsWith(ext));
}
function esImagen(mime) {
  return String(mime || "").toLowerCase().startsWith("image/");
}

/* ================= UTILIDADES ================= */
function limitar(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n) + "… [recortado]" : s;
}
function bloquearBlancos(s) {
  return String(s || "").replace(/\n{3,}/g, "\n\n");
}
