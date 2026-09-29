import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  ShoppingBag, X, Menu, Plus, Minus, Trash2, Pencil, ChevronRight, ChevronLeft, ChevronDown,
  MessageCircle, Lock, Check, Shirt, Upload, Package, Star, Sparkles, ArrowRight,
  LogOut, Loader2, ZoomIn, ZoomOut, ArrowUp, ArrowDown, Quote, Instagram, Search, Heart, GripVertical, Info,
  Sun, Moon, RotateCw, Facebook, Music2, Mail, Phone, MapPin, HelpCircle, SlidersHorizontal, RotateCcw,
  LayoutGrid, Eye, EyeOff, TrendingUp, UserPlus, KeyRound, Boxes, FolderPlus, ArrowLeft, Move
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

/* ------------------------------------------------------------------ */
/*  Supabase client                                                    */
/*  Reads the project URL and public anon key from environment        */
/*  variables you set in .env (see .env.example and the README).       */
/* ------------------------------------------------------------------ */

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

// Al abrir la web se piden muchas cosas a la vez (productos, categorías,
// ajustes, diseños, trabajos personalizados...), y varias de esas consultas
// son pesadas porque las fotos se guardan completas adentro de cada fila. Si
// todas viajan al mismo tiempo se pelean por los mismos recursos de la base
// y terminan canceladas por tardar demasiado ("statement timeout", error
// 57014) — eso es lo que hacía "desaparecer" productos y diseños enteros.
// Esta cola hace que todas las lecturas a la tabla compartida pasen de a una
// (nunca varias pesadas en simultáneo), para que cada una tenga todo el
// tiempo que necesita.
let kvQueueTail = Promise.resolve();
function queueKvRead(fn) {
  const result = kvQueueTail.then(fn, fn);
  kvQueueTail = result.then(() => {}, () => {});
  return result;
}

/* ------------------------------------------------------------------ */
/*  Config & helpers                                                   */
/* ------------------------------------------------------------------ */

const WHATSAPP_NUMBER = "34662317094";
const INSTAGRAM_URL = "https://www.instagram.com/kulto25";
// Este es el mail de tu cuenta de administrador. Registrate (o iniciá
// sesión) en "Mi cuenta" con este mail exacto y vas a ver el panel de
// administrador ahí mismo, en vez de la cuenta de cliente normal — no hace
// falta ninguna contraseña ni pantalla aparte. Cambialo por tu propio mail
// antes de publicar la web (ver el README).
const ADMIN_EMAIL = "admin@kulto.com";
// admin@kulto.com es solo el usuario para entrar al panel — no es un buzón
// real que alguien revise. Cualquier mail que el sistema le mande a esa
// dirección (código de verificación, recuperar contraseña, etc.) se manda en
// realidad acá, a la casilla de verdad del dueño. Ver sendEmail() más abajo.
const ADMIN_NOTIFICATION_EMAIL = "pablo.gutcha@gmail.com";
// Usada solo como confirmación extra antes de borrar pedidos en el panel de
// administrador — no tiene relación con el acceso al panel en sí.
const ADMIN_PASSWORD = "kulto2024";
// Secciones del panel de administrador que se le pueden dar (o no) a una
// cuenta de "admin con permisos limitados" — ver AdminCustomers y
// handleSetAdminPermissions. El dueño (ADMIN_EMAIL) siempre las tiene todas.
const ADMIN_TABS = [
  ["productos", "Productos"],
  ["personalizar", "Personalizar"],
  ["pedidos", "Pedidos"],
  ["ventas", "Ventas"],
  ["compras", "Compras"],
  ["clientes", "Clientes"],
  ["resenas", "Reseñas"],
  ["contacto", "Contacto"],
  ["ajustes", "Ajustes"],
];
const ADMIN_TAB_KEYS = ADMIN_TABS.map(([key]) => key);
const DEFAULT_CATEGORIES = [
  "Camisetas",
  "Sudaderas con capucha",
  "Sudaderas sin capucha",
  "Tops deportivos",
  "Llaveros y lanyards",
];

const DEFAULT_GROUPS = [];

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// Código corto para usar como referencia del producto (en vez del id interno,
// largo y sin sentido para nadie) — ej: "BEAGLE-001", "OVERSIZE-002". Se arma
// con la primera palabra del nombre + un número que solo se repite si ya hay
// otro producto con esa misma palabra inicial (ej: "Oversize Negra" y
// "Oversize Blanca" comparten familia pero se numeran distinto).
function generateSku(name, existingProducts = []) {
  const base = (name || "PROD")
    .trim()
    .split(/\s+/)[0]
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12) || "PROD";
  const used = new Set(existingProducts.map((p) => p.sku).filter(Boolean));
  let n = 1;
  let candidate = `${base}-${String(n).padStart(3, "0")}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${String(n).padStart(3, "0")}`;
  }
  return candidate;
}

// "En tendencia" automático: puntúa cada producto vendible combinando ventas
// (peso fuerte, es la señal más confiable) y vistas (peso liviano), y devuelve
// los ids de los que más puntaje sacan. Esto se suma —nunca reemplaza— a lo
// que el admin ya marcó a mano con el tilde "Tendencia" de cada prenda (ver
// Home y AdminSalesPanel). No escribe nada en el producto: se recalcula al
// vuelo con los datos que ya hay, así siempre está al día.
function computeTrendingIds(products, settings) {
  if (!settings?.trendingAutoEnabled) return new Set();
  const ranked = (products || [])
    .filter((p) => !p.tags?.template)
    .map((p) => ({ id: p.id, score: (p.salesCount || 0) * 3 + (p.viewsCount || 0) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, settings?.trendingAutoCount ?? 8);
  return new Set(ranked.map((p) => p.id));
}

function formatPrice(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

// Las fotos de un color pueden venir de dos sistemas distintos: el viejo
// (un array genérico "images") o el actual, por zona (frontImage, backImage,
// sleeveLeftImage, sleeveRightImage, cargadas una por una en el panel).
// Esto junta lo que haya, priorizando el array viejo si existe, para que el
// catálogo muestre la foto sin importar con cuál de los dos se cargó el color.
function getColorImages(color) {
  if (!color) return [];
  if (color.images && color.images.length) return color.images;
  return [color.frontImage, color.backImage, color.sleeveLeftImage, color.sleeveRightImage].filter(Boolean);
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// Dónde se guardan las fotos que se suben desde la web — como ARCHIVOS,
// no como texto adentro de una fila de la base. Así cada fila que guarda un
// producto/diseño/ajuste solo lleva un link cortito, sin importar cuántas
// fotos subas ni cuán grandes sean. Necesita que el bucket exista en el
// proyecto de Supabase con este nombre (ver supabase-setup.sql).
const STORAGE_BUCKET = "kulto-photos";

function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(",");
  const mime = (header.match(/data:(.*?);base64/) || [])[1] || "image/jpeg";
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Sube una foto ya comprimida (como "data:image/...;base64,...") al
// almacenamiento de archivos y devuelve su link público, o null si todavía
// no se puede (por ejemplo, si el bucket "kulto-photos" no existe) — en ese
// caso quien llama sigue funcionando igual que antes, guardando la foto
// completa en la base, para no romper nada mientras se configura Storage.
async function uploadDataUrlToStorage(dataUrl) {
  try {
    if (!dataUrl || !dataUrl.startsWith("data:")) return null;
    const blob = dataUrlToBlob(dataUrl);
    const ext = blob.type === "image/png" ? "png" : "jpg";
    const path = `${genId("img")}.${ext}`;
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) return null;
    const { data } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch {
    return null;
  }
}

// Guardar las fotos como texto (base64) directo en la base de datos hacía
// que una foto pesada volviera lenta o imposible de leer (junto con otras) —
// eso es lo que hacía "desaparecer" productos y diseños enteros. Esta
// función arregla los dos lados del problema:
// - Comprime la foto antes de guardarla: si es un PNG que en realidad no usa
//   transparencia, la pasa a JPEG (mucho más liviano), y si aun así queda
//   pesada, la achica un poco más — priorizando siempre la mejor calidad
//   posible dentro de un tamaño razonable.
// - Después, en vez de devolver esa foto comprimida para guardarla adentro
//   de la fila, la sube como archivo aparte y devuelve su link — así la fila
//   en sí queda liviana pase lo que pase. Si la subida falla (por ejemplo,
//   porque el bucket todavía no está creado), devuelve la foto comprimida
//   como antes, para que la web nunca deje de funcionar por esto.
function fileToBase64(file, cb, maxDim = 1000, quality = 0.82, format = "image/jpeg") {
  const MAX_BYTES = 900 * 1024; // tamaño de archivo seguro para leer sin trabas
  const MIN_DIM = 500;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = async () => {
      const render = (dim) => {
        let { width, height } = img;
        if (width > dim || height > dim) {
          if (width > height) { height = Math.round((height * dim) / width); width = dim; }
          else { width = Math.round((width * dim) / height); height = dim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        return { canvas, ctx, width, height };
      };
      const hasTransparency = (ctx, width, height) => {
        try {
          const { data } = ctx.getImageData(0, 0, width, height);
          // Revisamos una muestra de píxeles (no todos) para que sea rápido
          // incluso en imágenes grandes.
          for (let i = 3; i < data.length; i += 4 * 47) {
            if (data[i] < 255) return true;
          }
          return false;
        } catch {
          return true; // si no podemos leerlo, no arriesgamos a perder transparencia real
        }
      };
      let dim = maxDim;
      let { canvas, ctx, width, height } = render(dim);
      let useFormat = format;
      if (format === "image/png" && !hasTransparency(ctx, width, height)) {
        useFormat = "image/jpeg";
      }
      let out = canvas.toDataURL(useFormat, quality);
      let attempts = 0;
      while (out.length > MAX_BYTES && dim > MIN_DIM && attempts < 5) {
        dim = Math.round(dim * 0.75);
        ({ canvas, ctx, width, height } = render(dim));
        out = canvas.toDataURL(useFormat, quality);
        attempts++;
      }
      const uploadedUrl = await uploadDataUrlToStorage(out);
      cb(uploadedUrl || out);
    };
    img.onerror = () => cb(reader.result); // fall back to the original if resizing fails
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// Renders a garment photo plus zero or more customer-placed design images onto
// a single flat canvas, so the customer (and later the admin) can see exactly
// how the finished piece will look. `designs` is an array of
// { image, x, y, widthPct } where x/y are the % position of each design's
// CENTER and widthPct is its width as a fraction of the canvas width. Layers
// are drawn in array order, so later entries sit on top of earlier ones.
function composeDesignImage(garmentImage, garmentBg, designs) {
  return new Promise((resolve) => {
    if (!garmentImage) { resolve(null); return; }
    const layers = (designs || []).filter((d) => d && d.image);
    const W = 1000, H = 1250;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    // Desde que las fotos se guardan en Supabase Storage (URLs remotas) en vez
    // de texto embebido, dibujarlas en un canvas sin "crossOrigin" lo deja
    // "manchado" y toDataURL tira un error — antes esto dejaba la vista previa
    // cargando para siempre sin avisar nada. Ahora, si igual llegara a fallar,
    // mostramos que no se pudo generar en vez de trabarse.
    const finish = () => {
      try {
        resolve(canvas.toDataURL("image/jpeg", 0.9));
      } catch {
        resolve(null);
      }
    };

    const drawLayer = (index) => {
      if (index >= layers.length) { finish(); return; }
      const design = layers[index];
      const designImg = new Image();
      designImg.crossOrigin = "anonymous";
      designImg.onload = () => {
        const dW = W * design.widthPct;
        const dH = dW * (designImg.height / designImg.width);
        const cx = W * (design.x / 100);
        const cy = H * (design.y / 100);
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(((design.rotation || 0) * Math.PI) / 180);
        ctx.drawImage(designImg, -dW / 2, -dH / 2, dW, dH);
        ctx.restore();
        drawLayer(index + 1);
      };
      designImg.onerror = () => drawLayer(index + 1);
      designImg.src = design.image;
    };

    const bgImg = new Image();
    bgImg.crossOrigin = "anonymous";
    bgImg.onload = () => {
      ctx.fillStyle = garmentBg || "#f2f2f2";
      ctx.fillRect(0, 0, W, H);
      const scale = Math.min(W / bgImg.width, H / bgImg.height);
      const dw = bgImg.width * scale, dh = bgImg.height * scale;
      const dx = (W - dw) / 2, dy = (H - dh) / 2;
      ctx.drawImage(bgImg, dx, dy, dw, dh);
      drawLayer(0);
    };
    bgImg.onerror = finish;
    bgImg.src = garmentImage;
  });
}

function buildOrderMessage(order, settings) {
  const lines = [];
  lines.push(`Pedido nuevo KULTO`);
  lines.push(`N° de orden: ${order.id}`);
  lines.push(`Fecha: ${formatDate(order.date)}`);
  lines.push("");
  order.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.name}  (ref. ${it.sku})`);
    lines.push(`   Categoría: ${it.category}`);
    lines.push(`   Color: ${it.colorName}`);
    if (it.size) lines.push(`   Talle: ${it.size}`);
    if (it.designName) lines.push(`   Diseño: ${it.designName}`);
    if (it.designImage) lines.push(`   (subió una imagen de diseño — la ves en el panel o en el link de este pedido)`);
    if (it.previewImageFront || it.previewImageBack || it.previewImageSleeveLeft || it.previewImageSleeveRight) lines.push(`   (personalización con vista previa — la ves en el panel o en el link de este pedido)`);
    lines.push(`   Cantidad: ${it.qty}`);
    lines.push(`   Precio unidad: ${formatPrice(it.unitPrice)}`);
    lines.push("");
  });
  lines.push(`Subtotal: ${formatPrice(order.subtotal)}`);
  if (order.discountAmount > 0) {
    lines.push(`Descuento de bienvenida: -${formatPrice(order.discountAmount)}`);
  }
  if (order.deliveryMethod === "envio") {
    lines.push(`Envío a domicilio: ${order.shippingCost > 0 ? formatPrice(order.shippingCost) : "Gratis"}`);
    lines.push(`Dirección: ${formatAddress(order.address)}`);
  } else {
    lines.push(`Entrega: Recoge en persona (sin costo de envío)`);
  }
  lines.push(`Total: ${formatPrice(order.total)}`);
  if (order.customerName) lines.push(`Cliente: ${order.customerName}`);
  if (order.customerPhone) lines.push(`Teléfono: ${order.customerPhone}`);
  if (order.customerEmail) lines.push(`Email: ${order.customerEmail}`);
  if (order.comment) lines.push(`Comentario: ${order.comment}`);
  const hasCustom = order.items.some((it) => it.designName?.startsWith("Personalizado"));
  if (hasCustom) {
    lines.push("");
    lines.push("(Sé que los pedidos personalizados pueden demorar entre 3 y 7 días. Si llegara a necesitarlo antes, se los aviso por acá.)");
    if (settings?.depositEnabled) {
      const depositAmount = order.subtotal * ((settings.depositPercent || 0) / 100);
      lines.push("");
      lines.push(`Entiendo que para confirmar y empezar a producirlo mando una seña del ${settings.depositPercent}% (${formatPrice(depositAmount)}) por ${settings.depositInfo || "el medio que me indiquen"}, y el resto al recibirlo.`);
    }
  }
  return lines.join("\n");
}

function openWhatsApp(text) {
  const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
  window.open(url, "_blank");
}

// Envoltorio simple de estilos para que los mails se vean prolijos en
// cualquier cliente de correo (Gmail, Outlook, etc. no soportan <style> ni
// variables CSS, por eso todo va en línea).
function emailShell(storeName, bodyHtml) {
  return `
    <div style="font-family: Arial, Helvetica, sans-serif; background:#15131a; padding:32px 16px;">
      <div style="max-width:520px;margin:0 auto;background:#1f1c26;border-radius:16px;padding:32px;color:#f3efe6;">
        <p style="margin:0 0 20px;font-size:18px;font-weight:bold;letter-spacing:0.5px;">${storeName}</p>
        ${bodyHtml}
      </div>
    </div>
  `;
}

function buildVerificationEmailHtml(name, code, settings) {
  const storeName = settings?.logoText || "Kulto";
  return emailShell(storeName, `
    <p style="margin:0 0 12px;">Hola${name ? " " + name : ""},</p>
    <p style="margin:0 0 20px;">Usá este código para confirmar tu cuenta:</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;background:#15131a;border-radius:12px;padding:18px;margin:0 0 20px;">${code}</p>
    <p style="margin:0;color:#a9a2b0;font-size:13px;">Vale por 15 minutos. Si no pediste esto, podés ignorar este mail.</p>
  `);
}

function buildPasswordResetEmailHtml(name, code, settings, email) {
  const storeName = settings?.logoText || "Kulto";
  let link = null;
  try { link = `${window.location.origin}/?resetEmail=${encodeURIComponent(email)}&resetCode=${encodeURIComponent(code)}`; } catch { /* sin window (no debería pasar, se llama desde el navegador) */ }
  return emailShell(storeName, `
    <p style="margin:0 0 12px;">Hola${name ? " " + name : ""},</p>
    <p style="margin:0 0 20px;">Usá este código para elegir una contraseña nueva:</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;background:#15131a;border-radius:12px;padding:18px;margin:0 0 20px;">${code}</p>
    ${link ? `
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${link}" style="display:inline-block;background:#E8452C;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:bold;">Elegir contraseña nueva</a>
    </p>
    ` : ""}
    <p style="margin:0;color:#a9a2b0;font-size:13px;">Vale por 15 minutos. Si no pediste esto, podés ignorar este mail — tu contraseña actual sigue funcionando igual.</p>
  `);
}

// El formulario de "Contacto" del sitio (en vez de mostrar el mail/teléfono
// del dueño directamente) — siempre se manda a ADMIN_EMAIL, que sendEmail()
// redirige de verdad a ADMIN_NOTIFICATION_EMAIL.
function buildContactEmailHtml(data, settings) {
  const storeName = settings?.logoText || "Kulto";
  return emailShell(storeName, `
    <p style="margin:0 0 16px;">Nuevo mensaje de contacto desde la web.</p>
    <p style="margin:0 0 8px;"><strong>Nombre:</strong> ${data.name}</p>
    <p style="margin:0 0 8px;"><strong>Email:</strong> ${data.email}</p>
    <p style="margin:0 0 16px;"><strong>Asunto:</strong> ${data.subject}</p>
    <p style="margin:0 0 8px;"><strong>Mensaje:</strong></p>
    <p style="margin:0;white-space:pre-line;background:#15131a;border-radius:12px;padding:16px;">${data.message}</p>
  `);
}

// La respuesta que el admin manda desde el panel de administrador (pestaña
// "Contacto") a un mensaje ya recibido — incluye el texto que escribió, y si
// corresponde, cómo quedó la incidencia (cambio/devolución aprobado o no,
// descuento de regalo con su código) para que quede todo junto en un mail.
function buildContactReplyEmailHtml(ticket, replyText, settings) {
  const storeName = settings?.logoText || "Kulto";
  const decisionText =
    ticket.changeDecision === "aprobado" ? "Aprobamos tu cambio o devolución." :
    ticket.changeDecision === "rechazado" ? "No pudimos aprobar el cambio o devolución en este caso." :
    "";
  const discountText = ticket.discountPercent
    ? `Como disculpa por la incidencia, te regalamos un <strong>${ticket.discountPercent}% de descuento</strong> para tu próxima compra. Mencioná este código cuando hagas tu próximo pedido: <strong style="letter-spacing:2px;">${ticket.discountCode}</strong>`
    : "";
  return emailShell(storeName, `
    <p style="margin:0 0 12px;">Hola${ticket.name ? " " + ticket.name : ""},</p>
    <p style="margin:0 0 16px;">Te escribimos por tu consulta ("${ticket.subject}"):</p>
    <p style="margin:0 0 20px;white-space:pre-line;background:#15131a;border-radius:12px;padding:16px;">${replyText}</p>
    ${decisionText ? `<p style="margin:0 0 12px;">${decisionText}</p>` : ""}
    ${discountText ? `<p style="margin:0 0 12px;background:#15131a;border-radius:12px;padding:16px;">${discountText}</p>` : ""}
    <p style="margin:0;color:#a9a2b0;font-size:13px;">Si te queda alguna duda, respondé este mail o escribinos por WhatsApp.</p>
  `);
}

function buildRestockEmailHtml(productName, settings) {
  const storeName = settings?.logoText || "Kulto";
  return emailShell(storeName, `
    <p style="margin:0 0 12px;">¡Buenas noticias!</p>
    <p style="margin:0 0 20px;">Ya volvió el stock de <strong>${productName}</strong> — pedite el tuyo antes de que se agote de nuevo.</p>
  `);
}

// Se manda a mano desde el panel (Pedidos → "Pedir reseña") una vez que el
// pedido ya está completado/entregado. El link lleva a "Mi pedido" con el
// número de orden ya cargado, para que el cliente no tenga que escribirlo.
function buildReviewRequestEmailHtml(order, settings) {
  const storeName = settings?.logoText || "Kulto";
  let link = null;
  try { link = `${window.location.origin}/?review=${encodeURIComponent(order.id)}`; } catch { /* sin window (no debería pasar, se llama desde el navegador) */ }
  return emailShell(storeName, `
    <p style="margin:0 0 12px;">¡Hola${order.customerName ? " " + order.customerName : ""}!</p>
    <p style="margin:0 0 20px;">Esperamos que estés disfrutando tu pedido <strong>${order.id}</strong>. Si tenés un minuto, nos encantaría que nos cuentes cómo te fue — ayuda un montón a otros clientes a elegir.</p>
    ${link ? `
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${link}" style="display:inline-block;background:#E8452C;color:#fff;text-decoration:none;padding:12px 24px;border-radius:999px;font-weight:bold;">Dejar mi reseña</a>
    </p>
    ` : ""}
    <p style="margin:0;color:#a9a2b0;font-size:13px;">Si el botón no funciona, entrá a la web y buscá tu pedido con el número ${order.id} en "Mi pedido".</p>
  `);
}

function buildOrderEmailHtml(order, settings) {
  const storeName = settings?.logoText || "Kulto";
  const itemsHtml = order.items.map((it) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid #2c2833;">
        <p style="margin:0;font-weight:bold;">${it.name} ${it.qty > 1 ? `× ${it.qty}` : ""}</p>
        <p style="margin:2px 0 0;font-size:13px;color:#a9a2b0;">
          ${it.colorName || ""}${it.size ? ` · Talle ${it.size}` : ""}${it.designName ? ` · ${it.designName}` : ""}
        </p>
      </td>
      <td style="padding:8px 0;border-bottom:1px solid #2c2833;text-align:right;white-space:nowrap;">${formatPrice(it.unitPrice * it.qty)}</td>
    </tr>
  `).join("");

  const deliveryHtml = order.deliveryMethod === "envio"
    ? `<p style="margin:0 0 4px;">Envío a domicilio: ${order.shippingCost > 0 ? formatPrice(order.shippingCost) : "Gratis"}</p><p style="margin:0 0 16px;color:#a9a2b0;font-size:13px;">${formatAddress(order.address)}</p>`
    : `<p style="margin:0 0 16px;">Retiro en persona (sin costo de envío)</p>`;

  return emailShell(storeName, `
    <p style="margin:0 0 4px;">¡Gracias por tu compra${order.customerName ? ", " + order.customerName : ""}!</p>
    <p style="margin:0 0 20px;color:#a9a2b0;font-size:13px;">Pedido N° ${order.id} · ${formatDate(order.date)}</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${itemsHtml}</table>
    ${deliveryHtml}
    ${order.discountAmount > 0 ? `<p style="margin:0 0 4px;">Descuento: -${formatPrice(order.discountAmount)}</p>` : ""}
    <p style="margin:0 0 4px;font-size:18px;font-weight:bold;">Total: ${formatPrice(order.total)}</p>
    <p style="margin:20px 0 0;color:#a9a2b0;font-size:13px;">Te vamos a estar escribiendo por WhatsApp para coordinar el pago y la entrega. Cualquier duda, respondé este mismo mail o escribinos.</p>
  `);
}

// Calls the serverless function in /api/analyze-product.js to suggest a name,
// category and description from a product photo. Needs ANTHROPIC_API_KEY set
// on the server (Vercel) — see the README. Fails gracefully if not configured.
async function analyzeProductPhoto(imageBase64, categories) {
  try {
    const res = await fetch("/api/analyze-product", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: imageBase64, categories }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data.error || "No se pudo completar con IA en este momento." };
    }
    return { ok: true, ...data };
  } catch {
    return { ok: false, error: "No se pudo conectar con la IA. Revisá tu conexión o probá de nuevo." };
  }
}

// Calls the serverless function in /api/send-email.js (usa Resend) para
// mandar mails de verdad — confirmación de cuenta y aviso de compra. Necesita
// RESEND_API_KEY configurada en el servidor (Vercel) — ver el README. Nunca
// tira una excepción hacia arriba: si falla, devuelve { ok: false } y quien
// llama decide si eso bloquea algo o no (nunca debería bloquear el checkout).
async function sendEmail({ to, subject, html }) {
  // admin@kulto.com no es un mail real — cualquier cosa que el sistema le
  // quiera mandar (verificación, recuperar contraseña, etc.) se redirige a
  // la casilla real del dueño. Ver la constante ADMIN_NOTIFICATION_EMAIL.
  const finalTo = normalizeEmail(to) === normalizeEmail(ADMIN_EMAIL) ? ADMIN_NOTIFICATION_EMAIL : to;
  try {
    const res = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: finalTo, subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || "No se pudo enviar el mail." };
    return { ok: true };
  } catch {
    return { ok: false, error: "No se pudo conectar con el servidor de mails." };
  }
}

// Removes the background from a customer-uploaded design photo, entirely in
// the browser (via @imgly/background-removal — a free, open-source model
// that runs locally, no API key or server cost involved). Returns null if it
// fails for any reason, so callers can fall back to the original photo.
async function removeImageBackground(base64) {
  try {
    const { removeBackground } = await import("@imgly/background-removal");
    const sourceBlob = await (await fetch(base64)).blob();
    const resultBlob = await removeBackground(sourceBlob);
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(resultBlob);
    });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Storage layer                                                      */
/*  "shared" data (products, categories, orders, settings) lives in a  */
/*  Supabase table so every visitor sees the same catalog.             */
/*  "personal" data (each visitor's own cart) lives in their browser's */
/*  localStorage, since there's no need to sync it across devices.     */
/* ------------------------------------------------------------------ */

const KV_TABLE = "kulto_kv";

async function storageGet(key, shared) {
  try {
    if (!shared) {
      const v = localStorage.getItem(key);
      return v;
    }
    const { data, error } = await queueKvRead(() => supabase.from(KV_TABLE).select("value").eq("key", key).maybeSingle());
    if (error || !data) return null;
    return data.value;
  } catch {
    return null;
  }
}
async function storageSet(key, value, shared) {
  try {
    if (!shared) {
      localStorage.setItem(key, value);
      return true;
    }
    const { error } = await supabase.from(KV_TABLE).upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.error(`[Kulto] No se pudo guardar "${key}":`, error.message || error);
    return !error;
  } catch (err) {
    console.error(`[Kulto] Error guardando "${key}":`, err);
    return false;
  }
}
// Igual que storageSet, pero además devuelve el motivo del error en vez de
// tragárselo — se usa donde el motivo real le sirve a quien está usando la
// web (por ejemplo, para mostrarle al admin por qué no se guardó un diseño).
async function storageSetVerbose(key, value, shared) {
  try {
    if (!shared) {
      localStorage.setItem(key, value);
      return { ok: true, error: null };
    }
    const { error } = await supabase.from(KV_TABLE).upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) console.error(`[Kulto] No se pudo guardar "${key}":`, error.message || error);
    return { ok: !error, error: error ? (error.message || String(error)) : null };
  } catch (err) {
    console.error(`[Kulto] Error guardando "${key}":`, err);
    return { ok: false, error: err?.message || "Error de red." };
  }
}
async function storageDelete(key, shared) {
  try {
    if (!shared) {
      localStorage.removeItem(key);
      return;
    }
    await supabase.from(KV_TABLE).delete().eq("key", key);
  } catch {
    /* ignore */
  }
}

// "Notificarme" cuando vuelve el stock de un producto (ver RestockNotifyForm
// y ProductConfigurator). La lista de mails en espera por producto se guarda
// como un JSON simple bajo una key propia — no hace falta una tabla nueva.
function restockNotifyKey(productId) {
  return `kulto:restock:${productId}`;
}
async function getRestockSubscribers(productId) {
  const raw = await storageGet(restockNotifyKey(productId), true);
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
async function addRestockSubscriber(productId, email) {
  const norm = normalizeEmail(email);
  const list = await getRestockSubscribers(productId);
  if (list.includes(norm)) return { ok: true, already: true };
  await storageSet(restockNotifyKey(productId), JSON.stringify([...list, norm]), true);
  return { ok: true, already: false };
}
// Se llama al publicar cambios, para cada producto que pasó de sin stock a
// con stock — le avisa a todos los que pidieron que les avisen y vacía la
// lista (si vuelve a agotarse, se arma una lista nueva desde cero).
async function notifyRestockSubscribers(productId, productName, settings) {
  const list = await getRestockSubscribers(productId);
  if (!list.length) return;
  await Promise.all(
    list.map((email) =>
      sendEmail({
        to: email,
        subject: `Ya volvió el stock de ${productName}`,
        html: buildRestockEmailHtml(productName, settings),
      }).catch(() => {})
    )
  );
  await storageDelete(restockNotifyKey(productId), true);
}

// Fetches many keys in a single request instead of one request per key —
// this is what makes loading the catalog and orders fast.
async function storageGetMany(keys, shared) {
  if (!keys.length) return {};
  try {
    if (!shared) {
      const out = {};
      keys.forEach((k) => { const v = localStorage.getItem(k); if (v !== null) out[k] = v; });
      return out;
    }
    // Las fotos (diseños, trabajos personalizados, fotos de producto) se
    // guardan completas adentro de cada fila, y algunas pesan tanto que
    // leerlas junto con otras hace que la consulta tarde más de lo que
    // Supabase permite antes de cancelarla ("statement timeout", error 57014)
    // — eso hacía fallar el pedido entero y la tienda mostraba "no hay
    // productos/diseños guardados" aunque los datos seguían intactos en la
    // base. Reintentar la misma tanda no sirve porque va a volver a tardar lo
    // mismo: en cambio, si una tanda falla la partimos al medio y probamos
    // cada mitad por separado, hasta aislar (y en el peor caso pedir sola) la
    // foto puntual que está tardando, sin perder el resto de los datos.
    async function fetchChunk(chunk) {
      const { data, error } = await queueKvRead(() => supabase.from(KV_TABLE).select("key,value").in("key", chunk));
      if (!error && data) return data;
      if (chunk.length <= 1) return [];
      const mid = Math.ceil(chunk.length / 2);
      // De a una mitad por vez (no las dos juntas) — si el problema es que
      // varias consultas pesadas viajando a la vez se pisan entre sí, hacer
      // dos consultas en paralelo acá adentro tendría el mismo problema.
      const a = await fetchChunk(chunk.slice(0, mid));
      const b = await fetchChunk(chunk.slice(mid));
      return [...a, ...b];
    }
    const CHUNK_SIZE = 8;
    const chunks = [];
    for (let i = 0; i < keys.length; i += CHUNK_SIZE) chunks.push(keys.slice(i, i + CHUNK_SIZE));
    const out = {};
    for (const chunk of chunks) {
      const rows = await fetchChunk(chunk);
      rows.forEach((row) => { out[row.key] = row.value; });
    }
    return out;
  } catch {
    return {};
  }
}

const PUB_PREFIX = "kulto:";
const DRAFT_PREFIX = "kulto:draft:";

async function loadProductsFromPrefix(prefix) {
  const idxRaw = await storageGet(`${prefix}product-index`, true);
  const ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.length) return [];
  const keys = ids.map((id) => `${prefix}product:${id}`);
  const map = await storageGetMany(keys, true);
  return keys.map((k) => map[k]).filter(Boolean).map((v) => JSON.parse(v));
}
// "updateIndex=false" solo guarda la fila del producto, sin tocar el índice
// compartido — lo usan las operaciones en lote (publicar/descartar/inicializar
// el borrador) que guardan muchos productos a la vez y después escriben el
// índice completo una sola vez, para que no se pisen entre sí si dos
// guardados de índice ocurren en paralelo.
async function persistProductToPrefix(prefix, product, updateIndex = true) {
  await storageSet(`${prefix}product:${product.id}`, JSON.stringify(product), true);
  if (!updateIndex) return;
  const idxRaw = await storageGet(`${prefix}product-index`, true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.includes(product.id)) {
    ids.push(product.id);
    await storageSet(`${prefix}product-index`, JSON.stringify(ids), true);
  }
}
async function removeProductFromPrefix(prefix, id) {
  await storageDelete(`${prefix}product:${id}`, true);
  const idxRaw = await storageGet(`${prefix}product-index`, true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids = ids.filter((x) => x !== id);
  await storageSet(`${prefix}product-index`, JSON.stringify(ids), true);
}

// Published — what the public storefront reads.
async function loadProducts() { return loadProductsFromPrefix(PUB_PREFIX); }
async function persistProduct(product) { return persistProductToPrefix(PUB_PREFIX, product); }
async function removeProduct(id) { return removeProductFromPrefix(PUB_PREFIX, id); }

// Draft — what the admin edits. Stays invisible to the public until published.
async function loadDraftProducts() { return loadProductsFromPrefix(DRAFT_PREFIX); }
async function persistDraftProduct(product) { return persistProductToPrefix(DRAFT_PREFIX, product); }
async function removeDraftProduct(id) { return removeProductFromPrefix(DRAFT_PREFIX, id); }

async function loadCategories() {
  const raw = await storageGet("kulto:categories", true);
  if (raw) return JSON.parse(raw);
  await storageSet("kulto:categories", JSON.stringify(DEFAULT_CATEGORIES), true);
  return DEFAULT_CATEGORIES;
}
async function persistCategories(cats) {
  await storageSet("kulto:categories", JSON.stringify(cats), true);
}
async function loadDraftCategoriesRaw() {
  const raw = await storageGet("kulto:draft:categories", true);
  return raw ? JSON.parse(raw) : null;
}
async function persistDraftCategories(cats) {
  await storageSet("kulto:draft:categories", JSON.stringify(cats), true);
}

async function loadGroups() {
  const raw = await storageGet("kulto:groups", true);
  if (raw) return JSON.parse(raw);
  await storageSet("kulto:groups", JSON.stringify(DEFAULT_GROUPS), true);
  return DEFAULT_GROUPS;
}
async function persistGroups(groups) {
  await storageSet("kulto:groups", JSON.stringify(groups), true);
}
async function loadDraftGroupsRaw() {
  const raw = await storageGet("kulto:draft:groups", true);
  return raw ? JSON.parse(raw) : null;
}
async function persistDraftGroups(groups) {
  await storageSet("kulto:draft:groups", JSON.stringify(groups), true);
}

// The first time the admin opens the catalog editor, the draft starts as a
// copy of whatever's currently published, so they're editing from reality.
async function ensureDraftInitialized() {
  const flag = await storageGet("kulto:draft:initialized", true);
  if (flag === "true") return;
  const [pubProducts, pubCats, pubGroups] = await Promise.all([loadProducts(), loadCategories(), loadGroups()]);
  await Promise.all([
    ...pubProducts.map((p) => persistProductToPrefix(DRAFT_PREFIX, p, false)),
    persistDraftCategories(pubCats),
    persistDraftGroups(pubGroups),
  ]);
  await storageSet(`${DRAFT_PREFIX}product-index`, JSON.stringify(pubProducts.map((p) => p.id)), true);
  await storageSet("kulto:draft:initialized", "true", true);
}

async function loadDraftCategories() {
  await ensureDraftInitialized();
  const cats = await loadDraftCategoriesRaw();
  return cats || DEFAULT_CATEGORIES;
}
async function loadDraftGroups() {
  await ensureDraftInitialized();
  const groups = await loadDraftGroupsRaw();
  return groups || DEFAULT_GROUPS;
}

async function markDraftChanged() { await storageSet("kulto:draft:has-changes", "true", true); }
async function checkDraftChanges() { return (await storageGet("kulto:draft:has-changes", true)) === "true"; }

// Makes the draft catalog (products + categories + groups) the one the public sees.
async function publishDraft() {
  const [draftProducts, draftCats, draftGroups, pubProducts] = await Promise.all([
    loadDraftProducts(), loadDraftCategories(), loadDraftGroups(), loadProducts(),
  ]);
  const draftIds = new Set(draftProducts.map((p) => p.id));
  const toDelete = pubProducts.filter((p) => !draftIds.has(p.id));
  await Promise.all([
    ...toDelete.map((p) => storageDelete(`${PUB_PREFIX}product:${p.id}`, true)),
    ...draftProducts.map((p) => persistProductToPrefix(PUB_PREFIX, p, false)),
    persistCategories(draftCats),
    persistGroups(draftGroups),
  ]);
  await storageSet(`${PUB_PREFIX}product-index`, JSON.stringify(draftProducts.map((p) => p.id)), true);
  await storageSet("kulto:draft:has-changes", "false", true);
}

// Throws away unpublished edits, resetting the draft back to what's live.
async function discardDraft() {
  const [pubProducts, pubCats, pubGroups, draftProducts] = await Promise.all([
    loadProducts(), loadCategories(), loadGroups(), loadDraftProducts(),
  ]);
  const pubIds = new Set(pubProducts.map((p) => p.id));
  const toDelete = draftProducts.filter((p) => !pubIds.has(p.id));
  await Promise.all([
    ...toDelete.map((p) => storageDelete(`${DRAFT_PREFIX}product:${p.id}`, true)),
    ...pubProducts.map((p) => persistProductToPrefix(DRAFT_PREFIX, p, false)),
    persistDraftCategories(pubCats),
    persistDraftGroups(pubGroups),
  ]);
  await storageSet(`${DRAFT_PREFIX}product-index`, JSON.stringify(pubProducts.map((p) => p.id)), true);
  await storageSet("kulto:draft:has-changes", "false", true);
}


async function loadSavedColors() {
  const raw = await storageGet("kulto:saved-colors", true);
  return raw ? JSON.parse(raw) : [];
}
async function persistSavedColors(list) {
  await storageSet("kulto:saved-colors", JSON.stringify(list), true);
}

// Paleta oficial de colores del catálogo Roly 2026 (tal cual figura en el
// PDF del proveedor: número + nombre, y el color tomado directo de las
// muestras impresas). Los que no tienen nombre confirmado en el catálogo
// quedan como "Color NN" — el admin puede renombrarlos después si hace
// falta, sin perder el número ni el tono.
const ROLY_2026_COLORS = [
  { name: "01 Blanco", hex: "#ffffff" },
  { name: "02 Negro", hex: "#221f1f" },
  { name: "03 Amarillo", hex: "#f3dc2b" },
  { name: "05 Royal", hex: "#02518a" },
  { name: "Color 06", hex: "#877c6f" },
  { name: "07 Arena", hex: "#cfbc9f" },
  { name: "08 Moca", hex: "#997061" },
  { name: "10 Celeste", hex: "#8bc1e8" },
  { name: "12 Turquesa", hex: "#00afd9" },
  { name: "Color 13", hex: "#b4a16e" },
  { name: "15 Verde Militar", hex: "#63644e" },
  { name: "20 Verde Kelly", hex: "#0d7c4d" },
  { name: "Color 23", hex: "#636a77" },
  { name: "24 Verde Irish", hex: "#3fb76b" },
  { name: "Color 28", hex: "#b4c13b" },
  { name: "Color 29", hex: "#d5cdb1" },
  { name: "31 Naranja", hex: "#f68822" },
  { name: "Color 34", hex: "#d585b6" },
  { name: "Color 38", hex: "#3d4230" },
  { name: "Color 40", hex: "#cb1a7f" },
  { name: "43 Azul Profundo", hex: "#0e91c0" },
  { name: "45 Azul Luz de Luna", hex: "#004358" },
  { name: "46 Plomo Oscuro", hex: "#303738" },
  { name: "47 Gris", hex: "#909da3" },
  { name: "48 Rosa Claro", hex: "#f7c1d8" },
  { name: "55 Azul Marino", hex: "#103753" },
  { name: "56 Verde Botella", hex: "#044f3a" },
  { name: "57 Granate", hex: "#83203a" },
  { name: "58 Gris Vigoré", hex: "#a2a4aa" },
  { name: "60 Rojo", hex: "#c52027" },
  { name: "63 Morado", hex: "#45497b" },
  { name: "64 Burgundy", hex: "#86154e" },
  { name: "67 Nogal", hex: "#7f756a" },
  { name: "Color 69", hex: "#bcd86f" },
  { name: "71 Púrpura", hex: "#702571" },
  { name: "Color 72", hex: "#e25778" },
  { name: "73 Amarillo Sweet", hex: "#e9dba1" },
  { name: "78 Rosetón", hex: "#ca3c72" },
  { name: "83 Verde Grass", hex: "#3da648" },
  { name: "86 Azul Denim", hex: "#486880" },
  { name: "87 Chocolate", hex: "#3e2420" },
  { name: "Color 96", hex: "#f4c126" },
  { name: "98 Verde Menta", hex: "#a4d8cd" },
  { name: "Color 99", hex: "#044f94" },
  { name: "100 Azul Océano", hex: "#0d92c5" },
  { name: "101 Azul Sweet", hex: "#bbe6fa" },
  { name: "Color 106", hex: "#c32645" },
  { name: "Color 107", hex: "#4a4d3e" },
  { name: "108 Gris Piedra", hex: "#959595" },
  { name: "Color 112", hex: "#faee51" },
  { name: "114 Verde Oasis", hex: "#86c667" },
  { name: "Color 116", hex: "#540029" },
  { name: "118 Lima Limón", hex: "#e7e639" },
  { name: "120 Coral", hex: "#f37560" },
  { name: "121 Lila", hex: "#8e88a3" },
  { name: "125 Rosa Lady Flúor", hex: "#f2768f" },
  { name: "126 Azul Lavado", hex: "#85b2b7" },
  { name: "132 Blanco Vintage", hex: "#e2d8d6" },
  { name: "Color 143", hex: "#122b49" },
  { name: "152 Verde Aventura", hex: "#4d594a" },
  { name: "Color 157", hex: "#d9222d" },
  { name: "Color 158", hex: "#ffffff" },
  { name: "Color 159", hex: "#495347" },
  { name: "160 Ópalo", hex: "#939492" },
  { name: "Color 161", hex: "#ffffff" },
  { name: "Color 162", hex: "#ec3732" },
  { name: "Color 164", hex: "#6aa38e" },
  { name: "168 Rojo Pálido", hex: "#997179" },
  { name: "169 Rojo Baya", hex: "#7e525f" },
  { name: "170 Azul Tormenta", hex: "#547080" },
  { name: "Color 171", hex: "#7c959d" },
  { name: "172 Amarillo Curry", hex: "#b57833" },
  { name: "Color 176", hex: "#00b4d2" },
  { name: "Color 182", hex: "#ffffff" },
  { name: "Color 185", hex: "#023349" },
  { name: "216 Verde Tropical", hex: "#0d874c" },
  { name: "219 Arena Oscuro", hex: "#ae9d8c" },
  { name: "221 Amarillo Flúor", hex: "#e0e331" },
  { name: "222 Verde Flúor", hex: "#8cc63f" },
  { name: "223 Naranja Flúor", hex: "#f48241" },
  { name: "225 Lima", hex: "#83c342" },
  { name: "226 Verde Helecho", hex: "#22a64b" },
  { name: "228 Rosa Flúor", hex: "#ee468c" },
  { name: "229 Ángora", hex: "#efdabd" },
  { name: "230 Orquídea", hex: "#745899" },
  { name: "231 Ébano", hex: "#38424a" },
  { name: "Color 232", hex: "#5c653f" },
  { name: "234 Coral Flúor", hex: "#f2726d" },
  { name: "Color 235", hex: "#c3d734" },
  { name: "Color 236", hex: "#1598a7" },
  { name: "Color 242", hex: "#24a8e0" },
  { name: "261 Azul Riviera", hex: "#5d77a1" },
  { name: "262 Rojo Crisantemo", hex: "#c86768" },
  { name: "263 Azul Zen", hex: "#93a0b3" },
  { name: "264 Verde Mist", hex: "#c8d8be" },
  { name: "265 Naranja Greek", hex: "#b08b70" },
  { name: "266 Naranja Clay", hex: "#cf8f84" },
  { name: "267 Azul Dusty", hex: "#6a9497" },
  { name: "268 Lavanda", hex: "#9c899e" },
  { name: "275 Verde Laurel", hex: "#5a6a62" },
  { name: "276 Ocre", hex: "#bb9b57" },
  { name: "277 Teja", hex: "#a96a67" },
  { name: "278 Jade", hex: "#0fb69f" },
  { name: "Color 311", hex: "#f0652a" },
  { name: "316 Naranja Fuego", hex: "#ef4935" },
  { name: "Color 380", hex: "#343f31" },
  { name: "430 Azul Lago", hex: "#1d535d" },
  { name: "481 Rosa Seda", hex: "#f2829e" },
  { name: "643 Rojo Ciruela", hex: "#512640" },
  { name: "Color 651", hex: "#e22327" },
  { name: "Color 652", hex: "#ee436f" },
  { name: "711 Iris Púrpura", hex: "#6d5fa9" },
  { name: "777 Arándano", hex: "#80315f" },
];

// La primera vez que el admin entra después de esta actualización, suma
// automáticamente los colores de Roly 2026 a la librería de colores
// guardados (sin duplicar ni pisar los que ya existan, comparando por
// nombre) — así quedan disponibles para elegir en cualquier prenda sin
// tener que cargarlos a mano uno por uno.
async function seedRolyColorsIfNeeded(existing) {
  const existingNames = new Set(existing.map((c) => c.name.toLowerCase()));
  const missing = ROLY_2026_COLORS.filter((c) => !existingNames.has(c.name.toLowerCase()));
  if (!missing.length) return existing;
  const next = [...existing, ...missing];
  await persistSavedColors(next);
  return next;
}

// El número de cada color de Roly va al principio de su nombre ("05 Royal") o,
// para los que no tienen nombre oficial confirmado, después de "Color " ("Color
// 06") — esta función saca ese número de cualquiera de los dos formatos.
function rolyColorCode(name) {
  const m = name.match(/^(\d+)\b/) || name.match(/Color (\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// Busca colores del catálogo Roly 2026 a partir de una lista de números que el
// admin escribe de una (separados por coma, espacio o salto de línea — "01",
// "1" o "001" matchean el mismo color). Devuelve los que encontró (en el
// orden pedido, sin repetidos) y los números que no existen en el catálogo,
// para poder avisarle cuáles revisar.
function lookupRolyColorsByNumbers(input) {
  const codes = (input.match(/\d+/g) || []).map((n) => parseInt(n, 10));
  const byCode = new Map();
  ROLY_2026_COLORS.forEach((c) => {
    const code = rolyColorCode(c.name);
    if (code !== null && !byCode.has(code)) byCode.set(code, c);
  });
  const found = [];
  const notFound = [];
  const seen = new Set();
  codes.forEach((code) => {
    if (seen.has(code)) return;
    seen.add(code);
    const match = byCode.get(code);
    if (match) found.push(match);
    else notFound.push(code);
  });
  return { found, notFound };
}

// Librería general de diseños propios de Kulto (PNG), reutilizable en
// cualquier prenda dentro de Personalizar — independiente de un producto.
// Igual que los productos, cada diseño se guarda en su propia fila (clave
// "kulto:design:{id}") más un índice liviano con los ids — así un diseño no
// depende de que TODOS los demás se reenvíen juntos en un solo registro cada
// vez (eso era lo que hacía que, apenas la librería crecía un poco, el envío
// se pusiera pesado y fallara en silencio sin guardar nada).
async function loadDesignLibrary() {
  const idxRaw = await storageGet("kulto:design-index", true);
  const ids = idxRaw ? JSON.parse(idxRaw) : null;
  if (ids && ids.length) {
    const keys = ids.map((id) => `kulto:design:${id}`);
    const map = await storageGetMany(keys, true);
    return keys.map((k) => map[k]).filter(Boolean).map((v) => JSON.parse(v));
  }
  // Compatibilidad con el formato viejo (un solo registro con todos los
  // diseños juntos) — si queda alguno guardado así, lo migramos al nuevo formato.
  const legacyRaw = await storageGet("kulto:design-library", true);
  const legacy = legacyRaw ? JSON.parse(legacyRaw) : [];
  for (const d of legacy) await persistDesignToLibrary(d);
  return legacy;
}
// Devuelve { ok, error } en vez de un booleano solo — así, si falla, la
// pantalla de "Diseños propios de Kulto" le puede mostrar al admin el motivo
// real en vez de un genérico "no se guardó". Reintenta una vez cada guardado
// por si fue un corte de red pasajero, y — importante — si falla el guardado
// de la imagen en sí, NO actualiza el índice: antes, aunque la imagen no se
// guardara, el índice se actualizaba igual, y el diseño quedaba "fantasma"
// (aparecía guardado en el momento pero desaparecía en la próxima carga,
// porque el índice apuntaba a una fila que nunca llegó a existir).
async function persistDesignToLibrary(design) {
  const value = JSON.stringify(design);
  let row = await storageSetVerbose(`kulto:design:${design.id}`, value, true);
  if (!row.ok) row = await storageSetVerbose(`kulto:design:${design.id}`, value, true);
  if (!row.ok) return { ok: false, error: row.error || "No se pudo guardar la imagen." };

  const idxRaw = await storageGet("kulto:design-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.includes(design.id)) {
    ids.push(design.id);
    let idx = await storageSetVerbose("kulto:design-index", JSON.stringify(ids), true);
    if (!idx.ok) idx = await storageSetVerbose("kulto:design-index", JSON.stringify(ids), true);
    if (!idx.ok) return { ok: false, error: idx.error || "Se guardó la imagen pero no se pudo actualizar la lista de diseños." };
  }
  return { ok: true, error: null };
}
async function removeDesignFromLibrary(id) {
  await storageDelete(`kulto:design:${id}`, true);
  const idxRaw = await storageGet("kulto:design-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids = ids.filter((x) => x !== id);
  await storageSet("kulto:design-index", JSON.stringify(ids), true);
}

// Carpetas para organizar la librería de diseños (ver arriba) — cada diseño
// puede pertenecer a una carpeta (design.folderId) o quedar "suelto". Cada
// carpeta guarda además hasta 4 ids de diseño elegidos a mano por el admin
// como "portada" (lo que se ve de afuera de la tarjeta sin entrar).
async function loadDesignFolders() {
  const raw = await storageGet("kulto:design-folders", true);
  return raw ? JSON.parse(raw) : [];
}
async function persistDesignFolders(folders) {
  await storageSet("kulto:design-folders", JSON.stringify(folders), true);
}

// Galería de "trabajos personalizados" (fotos de pedidos reales, para mostrar
// en el inicio) — mismo esquema de fila-por-foto + índice liviano que la
// librería de diseños de arriba, por la misma razón: evitar que un solo
// registro gigante con todas las fotos juntas se ponga pesado y falle al
// guardar apenas la galería crece un poco.
async function loadCustomWorkGallery() {
  const idxRaw = await storageGet("kulto:customwork-index", true);
  const ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.length) return [];
  const keys = ids.map((id) => `kulto:customwork:${id}`);
  const map = await storageGetMany(keys, true);
  return keys.map((k) => map[k]).filter(Boolean).map((v) => JSON.parse(v));
}
async function persistCustomWorkPhoto(item) {
  const value = JSON.stringify(item);
  let row = await storageSetVerbose(`kulto:customwork:${item.id}`, value, true);
  if (!row.ok) row = await storageSetVerbose(`kulto:customwork:${item.id}`, value, true);
  if (!row.ok) return { ok: false, error: row.error || "No se pudo guardar la foto." };

  const idxRaw = await storageGet("kulto:customwork-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.includes(item.id)) {
    ids.push(item.id);
    let idx = await storageSetVerbose("kulto:customwork-index", JSON.stringify(ids), true);
    if (!idx.ok) idx = await storageSetVerbose("kulto:customwork-index", JSON.stringify(ids), true);
    if (!idx.ok) return { ok: false, error: idx.error || "Se guardó la foto pero no se pudo actualizar la lista." };
  }
  return { ok: true, error: null };
}
async function removeCustomWorkPhoto(id) {
  await storageDelete(`kulto:customwork:${id}`, true);
  const idxRaw = await storageGet("kulto:customwork-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids = ids.filter((x) => x !== id);
  await storageSet("kulto:customwork-index", JSON.stringify(ids), true);
}

// Cuentas de cliente — simples (email + contraseña), no reemplazan ni
// requieren el checkout por WhatsApp, solo habilitan el descuento de
// bienvenida y la tarjeta de puntos. La contraseña nunca se guarda en texto
// plano: se hashea con SHA-256 (Web Crypto, disponible en cualquier navegador).
async function hashPassword(pw) {
  try {
    const enc = new TextEncoder().encode(pw);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return pw; // entorno sin Web Crypto disponible — degradación mínima, no debería pasar en un navegador real
  }
}

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

async function loadCustomer(email) {
  const raw = await storageGet(`kulto:customer:${normalizeEmail(email)}`, true);
  return raw ? JSON.parse(raw) : null;
}
async function persistCustomer(customer) {
  await storageSet(`kulto:customer:${normalizeEmail(customer.email)}`, JSON.stringify(customer), true);
  const idxRaw = await storageGet("kulto:customer-index", true);
  let emails = idxRaw ? JSON.parse(idxRaw) : [];
  const norm = normalizeEmail(customer.email);
  if (!emails.includes(norm)) {
    emails.push(norm);
    await storageSet("kulto:customer-index", JSON.stringify(emails), true);
  }
}
async function loadAllCustomers() {
  const idxRaw = await storageGet("kulto:customer-index", true);
  const emails = idxRaw ? JSON.parse(idxRaw) : [];
  if (!emails.length) return [];
  const keys = emails.map((e) => `kulto:customer:${e}`);
  const map = await storageGetMany(keys, true);
  return keys.map((k) => map[k]).filter(Boolean).map((v) => JSON.parse(v));
}
async function removeCustomer(email) {
  const norm = normalizeEmail(email);
  await storageDelete(`kulto:customer:${norm}`, true);
  const idxRaw = await storageGet("kulto:customer-index", true);
  const emails = idxRaw ? JSON.parse(idxRaw) : [];
  await storageSet("kulto:customer-index", JSON.stringify(emails.filter((e) => e !== norm)), true);
}

async function loadPhotoInbox() {
  const raw = await storageGet("kulto:draft:photo-inbox", true);
  return raw ? JSON.parse(raw) : [];
}
async function persistPhotoInbox(list) {
  await storageSet("kulto:draft:photo-inbox", JSON.stringify(list), true);
}

const DEFAULT_THEME = { ink: "#15131A", bone: "#F3EFE6", signal: "#E8452C", sun: "#F4C430", slate: "#9A9488", cardShadow: "media" };

const CARD_SHADOWS = {
  ninguna: "none",
  suave: "0 4px 14px rgba(0,0,0,0.16)",
  media: "0 10px 22px rgba(0,0,0,0.26)",
  fuerte: "0 16px 34px rgba(0,0,0,0.4)",
};
const CARD_SHADOWS_HOVER = {
  ninguna: "0 4px 10px rgba(0,0,0,0.18)",
  suave: "0 10px 20px rgba(0,0,0,0.24)",
  media: "0 16px 30px rgba(0,0,0,0.34)",
  fuerte: "0 22px 40px rgba(0,0,0,0.48)",
};

// Comunidades autónomas + Ceuta y Melilla, para el selector de provincia del
// checkout y la tabla de precios de envío por destino en Ajustes → Envío.
const SPAIN_REGIONS = [
  "Andalucía", "Aragón", "Asturias", "Islas Baleares", "Canarias", "Cantabria",
  "Castilla-La Mancha", "Castilla y León", "Cataluña", "Ceuta",
  "Comunidad Valenciana", "Extremadura", "Galicia", "La Rioja", "Madrid",
  "Melilla", "Murcia", "Navarra", "País Vasco",
];

// Precios de partida por comunidad — a modo de referencia, pensados para un
// paquete chico (ropa) con un transportista de paquetería personal: en
// península suele costar lo mismo enviar a cualquier destino, mientras que
// Canarias, Ceuta y Melilla salen bastante más caros por el transporte
// especial que necesitan. El admin puede ajustar cada uno en Ajustes → Envío
// para que coincida con lo que realmente le cobra su transportista.
const DEFAULT_SHIPPING_REGION_PRICES = Object.fromEntries(
  SPAIN_REGIONS.map((region) => [region, ["Canarias", "Ceuta", "Melilla"].includes(region) ? 18 : (region === "Islas Baleares" ? 7.5 : 4.5)])
);

const DEFAULT_SETTINGS = {
  shippingFlatRate: 3.5, freeShippingThreshold: 30,
  shippingRegionPrices: DEFAULT_SHIPPING_REGION_PRICES,
  logoImage: null, logoText: "",
  heroTitle: "Tu estilo,\ntu kulto.",
  heroSubtitle: "Camisetas, sudaderas y accesorios sublimados a tu manera. Elige la prenda, el color y el diseño — nosotros lo estampamos.",
  heroImage: null,
  heroImages: [],
  howItWorksSteps: [],
  howItWorksCardSize: "md",
  howItWorksImageShape: "auto",
  productsMenuItems: [],
  personalizeGroupCovers: {},
  personalizeSubcategoryPrices: {},
  customWorkSpeed: 0.3,
  banners: [],
  homeSections: [],
  theme: DEFAULT_THEME,
  designFeedbackOptions: [
    "Quiero el fondo de otro color",
    "El diseño quedó muy chico",
    "El diseño quedó muy grande",
    "Se ve borrosa o pixelada",
    "Prefiero mandar otra foto",
  ],
  depositEnabled: true,
  depositPercent: 50,
  depositInfo: "Bizum al +34662317094",
  designServiceEnabled: true,
  designServiceFee: 2,
  personalizedBasePrice: 20,
  printSizeGuideEnabled: true,
  printSizeGuideFrontText: "El tamaño habitual para un diseño grande centrado en el pecho es de 25 a 30 cm de ancho por 30 a 38 cm de alto, empezando unos 5 a 8 cm por debajo del cuello. Si preferís un logo chico tipo pecho izquierdo, lo normal es de 8 a 12 cm de ancho y alto.",
  printSizeGuideBackText: "En la espalda el diseño grande puede ser un poco más grande: entre 30 y 35 cm de ancho (hasta 40-45 cm en estilos oversize) por 30 a 38 cm de alto, empezando unos 6 a 9 cm por debajo del cuello. Si es solo un detalle chico arriba, ronda los 10 a 14 cm de ancho por 3 a 8 cm de alto.",
  printSizeGuideFrontImage: null,
  printSizeGuideBackImage: null,
  qualityPolicyEnabled: true,
  qualityPolicyText: "Reponemos sin cargo cualquier prenda que llegue con fallas de fabricación.",
  productionTimeNormal: "3-5 días",
  signupDiscountEnabled: true,
  signupDiscountPercent: 10,
  loyaltyEnabled: true,
  loyaltyPointsPerItem: 1,
  loyaltyRewardThreshold: 5,
  loyaltyRewardDescription: "Cada 5 prendas compradas, la 6ta es gratis.",
  returnsPolicyEnabled: true,
  returnsPolicyText: "Tenés 10 días desde que recibís tu pedido para pedir un cambio o la devolución, siempre que la prenda esté sin usar, sin lavar y con sus etiquetas. Las prendas personalizadas o hechas a medida no tienen cambio salvo falla de fabricación. Escribinos por WhatsApp contándonos qué pasó y coordinamos los pasos a seguir.",
  // El bloque de preguntas frecuentes solo se muestra en el inicio (ver
  // FaqSection) — este tilde deja apagarlo del todo si no se quiere mostrar.
  faqEnabled: true,
  faqItems: [
    { id: "faq1", question: "¿Cuánto tarda en llegar mi pedido?", answer: "Los productos normales salen en 3-5 días hábiles. Los personalizados pueden tardar entre 3 y 7 días porque se sublimman a pedido." },
    { id: "faq2", question: "¿Puedo cambiar o devolver una prenda?", answer: "Sí, tenés 10 días desde que la recibís — mirá la sección de cambios y devoluciones más abajo para los detalles." },
    { id: "faq3", question: "¿Cómo sé qué talle pedir?", answer: "Cada prenda tiene su guía de talles en la ficha de producto, justo debajo de las opciones de talle." },
    { id: "faq4", question: "¿Cómo pago mi pedido?", answer: "Coordinamos el pago por WhatsApp al confirmar la compra — aceptamos Bizum y transferencia." },
  ],
  socialInstagram: "https://www.instagram.com/kulto25",
  socialFacebook: "",
  socialTiktok: "",
  contactEmail: "",
  contactPhone: "",
  contactAddress: "",
  // "En tendencia" automático: combina ventas y vistas de cada producto para
  // sumar (sin pisar) a los que el admin ya marcó a mano — ver
  // computeTrendingIds y AdminSalesPanel.
  trendingAutoEnabled: true,
  trendingAutoCount: 8,
  // Umbral de stock bajo para el apartado "Compras" del panel — ver
  // AdminRestockPanel.
  lowStockThreshold: 3,
};

const HOME_SECTION_DEFS = [
  { key: "bestsellers", label: "Más vendido" },
  { key: "ofertas", label: "En oferta" },
  { key: "tendencia", label: "Tendencia" },
  { key: "cta", label: 'Banner "Crea una prenda única"' },
  { key: "customwork", label: "Trabajos personalizados (galería)" },
  { key: "reviews", label: "Reseñas de clientes" },
];
const DEFAULT_HOME_SECTIONS = HOME_SECTION_DEFS.map((s) => ({ key: s.key, visible: true }));

// Combina las secciones fijas de la web con un ítem por cada banner que el
// admin haya marcado como "sección" (en vez de portada), respetando el orden
// y las visibilidades ya guardadas y agregando al final lo que sea nuevo.
function getEffectiveHomeSections(settings) {
  const staticKeys = HOME_SECTION_DEFS.map((d) => d.key);
  const sectionBanners = (settings.banners || []).filter((b) => b.placement === "section");
  const bannerKeys = sectionBanners.map((b) => `banner:${b.id}`);
  const allKeys = [...staticKeys, ...bannerKeys];
  const saved = settings.homeSections || [];
  const result = saved.filter((s) => allKeys.includes(s.key));
  allKeys.forEach((k) => {
    if (!result.some((s) => s.key === k)) result.push({ key: k, visible: true });
  });
  return result;
}

const EMPTY_ADDRESS = { street: "", number: "", apartment: "", city: "", state: "", postalCode: "", country: "España", reference: "" };

function formatAddress(a) {
  if (!a) return "";
  const line1 = [a.street, a.number].filter(Boolean).join(" ");
  const line2 = a.apartment ? `${a.apartment}` : "";
  const line3 = [a.postalCode, a.city].filter(Boolean).join(" ");
  const line4 = a.state || "";
  const lines = [line1, line2, line3, line4, a.country].filter(Boolean);
  return lines.join(", ") + (a.reference ? ` · Referencia: ${a.reference}` : "");
}

async function loadSettings() {
  const raw = await storageGet("kulto:settings", true);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...parsed, theme: { ...DEFAULT_THEME, ...(parsed.theme || {}) } };
    } catch { /* fall through */ }
  }
  return DEFAULT_SETTINGS;
}

async function persistSettings(settings) {
  await storageSet("kulto:settings", JSON.stringify(settings), true);
}

// --- Migración de fotos viejas a Storage ---------------------------------
// Todo lo de acá abajo es para las fotos que se guardaron ANTES de este
// cambio, que quedaron como texto enorme adentro de su fila (productos,
// ajustes, diseños, trabajos personalizados) — eso es lo que las hacía
// lentas o directamente imposibles de leer. Recorremos cada dato guardado
// buscando fotos "data:image/..." y las subimos a Storage, dejando en su
// lugar el link — así esas filas quedan livianas para siempre. Se corre una
// sola vez, en segundo plano, sin bloquear la carga de la tienda.
function isEmbeddedImage(v) {
  return typeof v === "string" && v.startsWith("data:image/") && v.length > 300;
}
// Recorre cualquier dato guardado (un producto, los ajustes, un diseño...) y
// reemplaza, en el lugar donde estén, todas las fotos embebidas que
// encuentre por su link en Storage — sin importar el nombre del campo ni
// qué tan anidado esté (colores de un producto, pasos de "cómo funciona",
// portadas por categoría, etc.), así no hace falta enumerar cada campo a mano.
async function migrateImagesDeep(value) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = await migrateImagesDeep(value[i]);
    return value;
  }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) value[k] = await migrateImagesDeep(value[k]);
    return value;
  }
  if (isEmbeddedImage(value)) {
    const url = await uploadDataUrlToStorage(value);
    return url || value;
  }
  return value;
}
// Migra un ítem (producto, diseño, foto de trabajo personalizado) y lo
// vuelve a guardar SOLO si de verdad tenía alguna foto vieja adentro —
// para no reescribir de más lo que ya está liviano.
async function migrateAndPersist(item, persistFn) {
  const before = JSON.stringify(item);
  const migrated = await migrateImagesDeep(item);
  if (JSON.stringify(migrated) !== before) await persistFn(migrated);
}
async function migrateLegacyImages({ products, draftProducts, designLibrary, customWorkGallery }) {
  // Probamos primero con una imagen mínima: si el bucket "kulto-photos"
  // todavía no está creado, esto falla al toque y no perdemos tiempo
  // recorriendo todo el catálogo para nada.
  const probeUrl = await uploadDataUrlToStorage(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  );
  if (!probeUrl) return;

  for (const p of products || []) await migrateAndPersist(p, persistProduct);
  for (const p of draftProducts || []) await migrateAndPersist(p, persistDraftProduct);
  for (const d of designLibrary || []) await migrateAndPersist(d, persistDesignToLibrary);
  for (const c of customWorkGallery || []) await migrateAndPersist(c, persistCustomWorkPhoto);
  // Los ajustes son una sola fila (no se puede dividir en tandas), así que
  // si tenían varias fotos juntas (portada del hero, pasos, portadas de
  // categoría) era justo lo que más rápido la hacía fallar al guardar.
  const settings = await loadSettings();
  await migrateAndPersist(settings, persistSettings);
}

async function loadOrders() {
  const idxRaw = await storageGet("kulto:order-index", true);
  const ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.length) return [];
  const keys = ids.map((id) => `kulto:order:${id}`);
  const map = await storageGetMany(keys, true);
  return keys.map((k) => map[k]).filter(Boolean).map((v) => JSON.parse(v));
}

async function persistOrder(order) {
  await storageSet(`kulto:order:${order.id}`, JSON.stringify(order), true);
  const idxRaw = await storageGet("kulto:order-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids.unshift(order.id);
  await storageSet("kulto:order-index", JSON.stringify(ids), true);
}

async function updateOrder(order) {
  await storageSet(`kulto:order:${order.id}`, JSON.stringify(order), true);
}

async function removeOrder(id) {
  await storageDelete(`kulto:order:${id}`, true);
  const idxRaw = await storageGet("kulto:order-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids = ids.filter((x) => x !== id);
  await storageSet("kulto:order-index", JSON.stringify(ids), true);
}

async function findOrderById(id) {
  const raw = await storageGet(`kulto:order:${id.trim().toUpperCase()}`, true);
  return raw ? JSON.parse(raw) : null;
}

async function loadReviews() {
  const idxRaw = await storageGet("kulto:review-index", true);
  const ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.length) return [];
  const keys = ids.map((id) => `kulto:review:${id}`);
  const map = await storageGetMany(keys, true);
  // Preserve the admin-chosen order from the index, not storage return order.
  return ids.map((id) => map[`kulto:review:${id}`]).filter(Boolean).map((v) => JSON.parse(v));
}

async function persistReview(review) {
  await storageSet(`kulto:review:${review.id}`, JSON.stringify(review), true);
  const idxRaw = await storageGet("kulto:review-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.includes(review.id)) {
    ids.push(review.id);
    await storageSet("kulto:review-index", JSON.stringify(ids), true);
  }
}

async function removeReview(id) {
  await storageDelete(`kulto:review:${id}`, true);
  const idxRaw = await storageGet("kulto:review-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids = ids.filter((x) => x !== id);
  await storageSet("kulto:review-index", JSON.stringify(ids), true);
}

async function persistReviewOrder(ids) {
  await storageSet("kulto:review-index", JSON.stringify(ids), true);
}

// Mensajes que llegan por el formulario de "Contacto" — se guardan acá,
// además de mandarse por mail, para que el admin los pueda ver, responder,
// y marcar cómo quedó la incidencia (resuelta o no, cambio/devolución
// aprobado o no, y si se le regaló un % de descuento para la próxima compra)
// desde el panel de administrador.
async function loadContactMessages() {
  const idxRaw = await storageGet("kulto:contact-index", true);
  const ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.length) return [];
  const keys = ids.map((id) => `kulto:contact:${id}`);
  const map = await storageGetMany(keys, true);
  return ids
    .map((id) => map[`kulto:contact:${id}`])
    .filter(Boolean)
    .map((v) => JSON.parse(v))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
async function persistContactMessage(msg) {
  await storageSet(`kulto:contact:${msg.id}`, JSON.stringify(msg), true);
  const idxRaw = await storageGet("kulto:contact-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  if (!ids.includes(msg.id)) {
    ids.push(msg.id);
    await storageSet("kulto:contact-index", JSON.stringify(ids), true);
  }
}
async function removeContactMessage(id) {
  await storageDelete(`kulto:contact:${id}`, true);
  const idxRaw = await storageGet("kulto:contact-index", true);
  let ids = idxRaw ? JSON.parse(idxRaw) : [];
  ids = ids.filter((x) => x !== id);
  await storageSet("kulto:contact-index", JSON.stringify(ids), true);
}

function genDiscountCode(percent) {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `KULTO${percent}-${rand}`;
}

async function loadCartState() {
  const raw = await storageGet("kulto:cart-state", false);
  if (raw) {
    try { return JSON.parse(raw); } catch { /* fall through */ }
  }
  return { items: [], email: "", name: "", phone: "", savedAt: null };
}
async function persistCartState(state) {
  await storageSet("kulto:cart-state", JSON.stringify(state), false);
}

const ABANDONED_HOURS = 24;
function hoursSince(ts) {
  if (!ts) return 0;
  return (Date.now() - ts) / 36e5;
}

/* ------------------------------------------------------------------ */
/*  Global style (design tokens)                                       */
/* ------------------------------------------------------------------ */

function GlobalStyle({ colors }) {
  const c = { ...DEFAULT_THEME, ...(colors || {}) };
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Archivo+Black&family=Inter:wght@400;500;600;700;800&display=swap');
      :root{
        --ink:${c.ink};
        --ink-2:color-mix(in srgb, ${c.ink} 88%, white);
        --ink-3:color-mix(in srgb, ${c.ink} 78%, white);
        --bone:${c.bone};
        --signal:${c.signal};
        --sun:${c.sun};
        --slate:${c.slate};
        --line:color-mix(in srgb, ${c.bone} 14%, transparent);
        --font-display:'Archivo Black', 'Inter', sans-serif;
        --font-body:'Inter', sans-serif;
      }
      .kulto-root{ font-family:var(--font-body); background:var(--ink); color:var(--bone); transition:filter .25s ease; }
      .kulto-root *{ box-sizing:border-box; }
      /* Modo claro: en vez de redefinir cada color a mano (la web entera da
         por sentado que el fondo es oscuro y el texto claro, en cientos de
         lugares), invertimos toda la página y le devolvemos el color
         original a las fotos — así se mantiene siempre el mismo contraste
         entre fondo y texto, sin botones que queden ilegibles. */
      .kulto-root[data-mode="light"]{ filter:invert(1) hue-rotate(180deg); }
      .kulto-root[data-mode="light"] img,
      .kulto-root[data-mode="light"] video{ filter:invert(1) hue-rotate(180deg) !important; }
      @media (prefers-reduced-motion: reduce){
        .kulto-root{ transition:none !important; }
      }
      .kulto-display{ font-family:var(--font-display); text-transform:uppercase; }
      .kulto-scrollbar::-webkit-scrollbar{ height:6px; width:6px; }
      .kulto-scrollbar::-webkit-scrollbar-thumb{ background:var(--line); border-radius:99px; }
      .kulto-btn{ cursor:pointer; transition:transform .15s ease, opacity .15s ease; }
      .kulto-btn:hover{ opacity:.88; }
      .kulto-btn:active{ transform:scale(0.97); }
      .kulto-card:hover .kulto-card-img{ transform:scale(1.12); }
      .kulto-card-img{ transition:transform .3s ease; }
      .kulto-card{ transition:box-shadow .25s ease, transform .25s ease; box-shadow:${CARD_SHADOWS[c.cardShadow] || CARD_SHADOWS.media}; }
      .kulto-card:hover{ box-shadow:${CARD_SHADOWS_HOVER[c.cardShadow] || CARD_SHADOWS_HOVER.media}; transform:translateY(-3px); }
      .kulto-banner-tile:hover .kulto-banner-tile-img{ transform:scale(1.06); }
      .kulto-banner-tile-img{ transition:transform .4s ease; }
      .kulto-banner-tile{ transition:transform .25s ease, box-shadow .25s ease; }
      .kulto-banner-clickable:hover{ transform:scale(1.012); box-shadow:0 0 0 3px var(--banner-glow, transparent), 0 18px 40px -14px var(--banner-glow, transparent); }
      .kulto-flip-outer{ position:relative; perspective:1200px; }
      .kulto-flip-inner{ position:absolute; inset:0; transition:transform .5s; transform-style:preserve-3d; }
      .kulto-flip-face{ position:absolute; inset:0; width:100%; height:100%; backface-visibility:hidden; -webkit-backface-visibility:hidden; }
      .kulto-flip-back{ transform:rotateY(180deg); }
      .kulto-flip-inner.is-flipped{ transform:rotateY(180deg); }
      @media (hover:hover){
        .kulto-flip-outer:hover .kulto-flip-inner{ transform:rotateY(180deg); }
      }
      @media (prefers-reduced-motion: reduce){
        .kulto-flip-inner{ transition:none !important; }
      }
      @keyframes kulto-hero-fadein{ from{ opacity:0; transform:translateY(6px); } to{ opacity:1; transform:translateY(0); } }
      .kulto-hero-fade{ animation:kulto-hero-fadein .5s ease; }
      @media (prefers-reduced-motion: reduce){
        .kulto-hero-fade{ animation:none !important; }
      }
      input, textarea, select{ font-family:var(--font-body); outline:none; }
      input:focus, textarea:focus, select:focus{ box-shadow:0 0 0 2px var(--sun); }
      ::selection{ background:var(--sun); color:var(--ink); }
      @keyframes kulto-marquee{ from{ transform:translateX(0); } to{ transform:translateX(-50%); } }
      .kulto-marquee-track{ display:flex; width:max-content; animation:kulto-marquee 24s linear infinite; }
      @keyframes kulto-shimmer{ 0%{ background-position:100% 50%; } 100%{ background-position:0 50%; } }
      .kulto-skel{ background:linear-gradient(90deg, var(--ink-2) 25%, var(--ink-3) 37%, var(--ink-2) 63%); background-size:400% 100%; animation:kulto-shimmer 1.4s ease infinite; }
      @media (prefers-reduced-motion: reduce){
        .kulto-btn, .kulto-card-img, .kulto-card, .kulto-banner-tile-img, .kulto-banner-tile{ transition:none !important; }
        .kulto-marquee-track{ animation:none !important; }
      }
    `}</style>
  );
}

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function Badge({ children, tone = "signal" }) {
  const bg = tone === "signal" ? "var(--signal)" : tone === "sun" ? "var(--sun)" : "var(--ink-3)";
  const color = tone === "sun" ? "var(--ink)" : "var(--bone)";
  return (
    <span
      className="text-xs font-semibold px-2 py-1 rounded-full"
      style={{ background: bg, color }}
    >
      {children}
    </span>
  );
}

// Migas de pan simples: cada paso es { label, onClick } — el último paso
// (la página actual) no lleva onClick y se muestra sin subrayar.
function Breadcrumbs({ steps = [] }) {
  if (steps.length < 2) return null;
  return (
    <nav aria-label="Ruta de navegación" className="flex items-center flex-wrap gap-1 text-xs mb-4" style={{ color: "var(--slate)" }}>
      {steps.map((s, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={12} />}
          {s.onClick && i < steps.length - 1 ? (
            <button onClick={s.onClick} className="kulto-btn hover:underline" style={{ color: "var(--slate)" }}>
              {s.label}
            </button>
          ) : (
            <span style={{ color: i === steps.length - 1 ? "var(--bone)" : "var(--slate)" }}>{s.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function SectionTitle({ eyebrow, title, action }) {
  return (
    <div className="flex items-end justify-between mb-5 gap-4">
      <div>
        {eyebrow && (
          <div className="text-sm mb-1" style={{ color: "var(--sun)" }}>{eyebrow}</div>
        )}
        <h2 className="kulto-display text-2xl md:text-3xl" style={{ color: "var(--bone)" }}>{title}</h2>
      </div>
      {action}
    </div>
  );
}

function EmptyState({ text, cta }) {
  return (
    <div
      className="rounded-2xl p-8 text-center"
      style={{ background: "var(--ink-2)", border: "1px dashed var(--line)" }}
    >
      <Package size={28} style={{ color: "var(--slate)", margin: "0 auto 10px" }} />
      <p style={{ color: "var(--slate)" }} className="text-sm">{text}</p>
      {cta}
    </div>
  );
}

function ColorSwatch({ hex, selected, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="kulto-btn rounded-full"
      style={{
        width: 34, height: 34, background: hex,
        border: selected ? "3px solid var(--sun)" : "2px solid rgba(243,239,230,0.35)",
        boxShadow: selected ? "0 0 0 2px var(--ink-2)" : "none",
      }}
    />
  );
}

// Small "Ver guía de talles" link that expands into a table of medidas y/o
// una imagen (por ejemplo, la foto de la tabla de talles del fabricante) —
// cada prenda puede tener una, la otra, o las dos. Renders nothing if the
// product has neither loaded.
function SizeGuideToggle({ sizeGuide, sizeGuideImage }) {
  const [open, setOpen] = useState(false);
  const hasTable = sizeGuide && sizeGuide.length > 0;
  const hasImage = !!sizeGuideImage;
  if (!hasTable && !hasImage) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="kulto-btn text-xs font-semibold underline"
        style={{ color: "var(--slate)" }}
      >
        {open ? "Ocultar guía de talles" : "Ver guía de talles"}
      </button>
      {open && (
        <div className="mt-2 flex flex-col gap-2">
          {hasTable && (
            <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--line)" }}>
              {sizeGuide.map((g, i) => (
                <div
                  key={g.size}
                  className="flex items-center gap-3 px-3 py-2 text-xs"
                  style={{ background: i % 2 === 0 ? "var(--ink-2)" : "transparent", color: "var(--bone)" }}
                >
                  <span className="font-semibold w-12 shrink-0">{g.size}</span>
                  <span style={{ color: "var(--slate)" }}>{g.measurements}</span>
                </div>
              ))}
            </div>
          )}
          {hasImage && (
            <img
              loading="lazy"
              src={sizeGuideImage}
              alt="Guía de talles con las medidas de la prenda"
              className="w-full rounded-xl"
              style={{ border: "1px solid var(--line)" }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Guía de tamaños de estampado en el paso de diseño de Personalizar — un
// texto (editable por el administrador) que aclara qué medidas suele tener
// un diseño grande, uno chico tipo bolsillo, etc. en esa zona (adelante o
// atrás), para que el cliente sepa de antemano el tamaño aproximado y no se
// lleve una sorpresa cuando le llegue la prenda. No aplica a mangas.
function PrintSizeGuide({ settings, zone }) {
  const [open, setOpen] = useState(false);
  if (!settings?.printSizeGuideEnabled) return null;
  if (zone !== "front" && zone !== "back") return null;
  const text = zone === "back" ? settings?.printSizeGuideBackText : settings?.printSizeGuideFrontText;
  const image = zone === "back" ? settings?.printSizeGuideBackImage : settings?.printSizeGuideFrontImage;
  if (!text && !image) return null;
  return (
    <div className="mt-3 max-w-md mx-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="kulto-btn text-xs font-semibold underline block mx-auto"
        style={{ color: "var(--slate)" }}
      >
        {open ? "Ocultar guía de tamaños del diseño" : "Ver guía de tamaños del diseño"}
      </button>
      {open && (
        <div className="mt-2 rounded-xl p-3 flex flex-col gap-3 sm:flex-row sm:items-start" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          {image && (
            <img
              loading="lazy"
              src={image}
              alt={`Guía de tamaños de estampado - ${zone === "back" ? "espalda" : "adelante"}`}
              className="w-full sm:w-28 sm:shrink-0 rounded-lg"
              style={{ aspectRatio: "4 / 5", objectFit: "cover", border: "1px solid var(--line)" }}
            />
          )}
          {text && (
            <p className="text-xs whitespace-pre-line" style={{ color: "var(--bone)" }}>{text}</p>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Product card                                                       */
/* ------------------------------------------------------------------ */

function ProductCard({ product, onOpen, isFavorite, onToggleFavorite, onAddToCart }) {
  const colors = product.colors || [];
  // Armamos una sola lista con las fotos de TODOS los colores, una atrás de
  // la otra (o el pool general del producto si no hay fotos cargadas por
  // color) — así las flechitas dejan ver todas las fotos del producto sin
  // tener que entrar a él, sea como sea que estén organizadas (aunque cada
  // color tenga una sola foto). "starts[i]" guarda en qué posición de esa
  // lista arrancan las fotos del color i (o null si ese color no tiene fotos
  // propias cargadas).
  const starts = [];
  let combined = [];
  colors.forEach((c) => {
    const imgs = getColorImages(c);
    if (imgs.length > 0) {
      starts.push(combined.length);
      combined = combined.concat(imgs);
    } else {
      starts.push(null);
    }
  });
  if (combined.length === 0 && product.photoPool && product.photoPool.length) {
    combined = product.photoPool;
  }
  const images = combined;

  const [idx, setIdx] = useState(0);
  // A qué color pertenece la foto que se está mostrando, para resaltar el
  // punto correspondiente aunque se haya llegado ahí con las flechitas.
  let activeColorIdx = -1;
  starts.forEach((s, i) => { if (s !== null && s <= idx) activeColorIdx = i; });
  const activeColor = activeColorIdx >= 0 ? colors[activeColorIdx] : colors[0];

  const onSale = product.tags?.oferta && product.salePrice;
  const isCover = product.imageFit === "cover";
  const bg = product.imageBackground || (activeColor ? activeColor.hex : "var(--ink-3)");

  const prev = (e) => { e.stopPropagation(); setIdx((i) => (i - 1 + images.length) % images.length); };
  const next = (e) => { e.stopPropagation(); setIdx((i) => (i + 1) % images.length); };
  const pickColor = (e, i) => { e.stopPropagation(); if (starts[i] !== null) setIdx(starts[i]); };

  // "Agregar rápido" — solo para productos que no necesitan que el cliente
  // elija o suba un diseño (esos siguen yendo por la ficha completa) y que
  // tengan stock. Igual pedimos el talle explícitamente (no se preselecciona
  // ninguno) para no repetir el problema de las devoluciones por talle mal
  // adivinado que ya resolvimos en otro lado.
  const hasPresetDesigns = product.designs && product.designs.length > 0;
  const allowCustomDesign = product.tags?.customDesign === true;
  const needsDesignStep = hasPresetDesigns || allowCustomDesign;
  const outOfStock = (product.stock ?? 0) <= 0;
  const hasSizes = product.sizes && product.sizes.length > 0;
  const canQuickAdd = !!onAddToCart && !needsDesignStep && !outOfStock;

  const [quickOpen, setQuickOpen] = useState(false);
  const [quickColorIdx, setQuickColorIdx] = useState(0);
  const [quickSizeIdx, setQuickSizeIdx] = useState(null);
  const [quickQty, setQuickQty] = useState(1);
  const [quickJustAdded, setQuickJustAdded] = useState(false);

  // Si el cliente sigue scrolleando la página con la ventanita abierta, la
  // cerramos sola en vez de dejarla flotando pegada a la pantalla.
  useEffect(() => {
    if (!quickOpen) return;
    const closeOnScroll = () => setQuickOpen(false);
    window.addEventListener("scroll", closeOnScroll, { passive: true });
    return () => window.removeEventListener("scroll", closeOnScroll);
  }, [quickOpen]);

  const openQuickAdd = (e) => {
    e.stopPropagation();
    setQuickColorIdx(activeColorIdx >= 0 ? activeColorIdx : 0);
    setQuickSizeIdx(null);
    setQuickQty(1);
    setQuickOpen(true);
  };

  const handleQuickAdd = () => {
    if (hasSizes && quickSizeIdx === null) return;
    const qColor = colors[quickColorIdx];
    const item = {
      cartId: genId("c"),
      productId: product.id,
      sku: product.sku || product.id,
      name: product.name,
      category: product.category,
      colorName: qColor ? qColor.name : "Único",
      colorHex: qColor ? qColor.hex : "#999",
      size: hasSizes ? product.sizes[quickSizeIdx] : null,
      designName: null,
      designImage: null,
      qty: quickQty,
      unitPrice: onSale ? product.salePrice : product.price,
      points: product.points ?? null,
      previewImage: images[idx] || null,
    };
    onAddToCart(item);
    setQuickJustAdded(true);
    setTimeout(() => { setQuickJustAdded(false); setQuickOpen(false); }, 1100);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(product)}
      onKeyDown={(e) => e.key === "Enter" && onOpen(product)}
      className="kulto-card kulto-btn text-left rounded-2xl overflow-hidden flex flex-col w-full h-full cursor-pointer"
      style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
    >
      <div
        className="relative overflow-hidden"
        style={{ background: bg, aspectRatio: "4 / 5" }}
      >
        {images.length > 0 ? (
          <img loading="lazy" src={images[idx]} alt={product.name} className={`kulto-card-img w-full h-full ${isCover ? "object-cover" : "object-contain"}`} />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Shirt size={36} style={{ color: "rgba(243,239,230,0.35)" }} />
          </div>
        )}
        <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
          {product.tags?.oferta && <Badge tone="signal">Oferta</Badge>}
          {product.tags?.bestseller && <Badge tone="sun">Más vendido</Badge>}
          {(product.stock ?? 0) <= 0 && <Badge tone="neutral">Sin stock</Badge>}
        </div>
        {onToggleFavorite && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(product.id); }}
            className="kulto-btn absolute top-2 right-2 w-8 h-8 rounded-full flex items-center justify-center"
            style={{ background: "rgba(21,19,26,0.55)" }}
            title={isFavorite ? "Quitar de favoritos" : "Guardar en favoritos"}
          >
            <Heart size={16} style={{ color: isFavorite ? "var(--signal)" : "var(--bone)" }} fill={isFavorite ? "var(--signal)" : "none"} />
          </button>
        )}
        {images.length > 1 && (
          <>
            <button
              onClick={prev}
              className="kulto-btn absolute left-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: "rgba(21,19,26,0.55)", color: "var(--bone)" }}
              aria-label="Foto anterior"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              onClick={next}
              className="kulto-btn absolute right-1 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center"
              style={{ background: "rgba(21,19,26,0.55)", color: "var(--bone)" }}
              aria-label="Foto siguiente"
            >
              <ChevronRight size={18} />
            </button>
            <div className="absolute bottom-1.5 left-0 right-0 flex items-center justify-center gap-1">
              {images.map((_, i) => (
                <span key={i} className="rounded-full" style={{ width: i === idx ? 12 : 5, height: 5, background: i === idx ? "var(--sun)" : "rgba(243,239,230,0.5)", transition: "width .15s" }} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="p-3 flex flex-col gap-1.5 flex-1">
        <span className="text-xs" style={{ color: "var(--slate)" }}>{product.category}</span>
        <span
          className="font-semibold leading-snug"
          style={{
            color: "var(--bone)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            minHeight: "2.6em",
          }}
        >
          {product.name}
        </span>
        {colors.length > 0 && (
          <div className="flex items-center gap-1.5 mt-0.5">
            {colors.slice(0, 5).map((c, i) => (
              <button
                key={i}
                type="button"
                onClick={(e) => pickColor(e, i)}
                className="kulto-btn rounded-full shrink-0"
                style={{
                  width: 14,
                  height: 14,
                  background: c.hex,
                  border: i === activeColorIdx ? "2px solid var(--sun)" : "1px solid rgba(243,239,230,0.3)",
                }}
                title={c.name}
                aria-label={`Ver ${product.name} en color ${c.name}`}
              />
            ))}
            {colors.length > 5 && (
              <span className="text-xs" style={{ color: "var(--slate)" }}>+{colors.length - 5}</span>
            )}
          </div>
        )}
        <div className="flex items-center gap-2 mt-auto pt-1">
          {onSale ? (
            <>
              <span className="font-bold" style={{ color: "var(--sun)" }}>{formatPrice(product.salePrice)}</span>
              <span className="text-sm line-through" style={{ color: "var(--slate)" }}>{formatPrice(product.price)}</span>
            </>
          ) : (
            <span className="font-bold" style={{ color: "var(--sun)" }}>{formatPrice(product.price)}</span>
          )}
          {canQuickAdd && (
            <button
              type="button"
              onClick={openQuickAdd}
              className="kulto-btn ml-auto w-8 h-8 rounded-full flex items-center justify-center shrink-0"
              style={{ background: "var(--signal)", color: "var(--bone)" }}
              title="Agregar al carrito"
              aria-label={`Agregar ${product.name} al carrito`}
            >
              <ShoppingBag size={15} />
            </button>
          )}
        </div>
      </div>
      {quickOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.65)" }}
          onClick={(e) => { e.stopPropagation(); setQuickOpen(false); }}
        >
          <div onClick={(e) => e.stopPropagation()} className="rounded-2xl p-5 max-w-xs w-full" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
            <div className="flex items-center justify-between mb-4">
              <p className="text-sm font-semibold pr-3" style={{ color: "var(--bone)" }}>{product.name}</p>
              <button onClick={() => setQuickOpen(false)} className="kulto-btn shrink-0" style={{ color: "var(--slate)" }}><X size={18} /></button>
            </div>
            {colors.length > 0 && (
              <div className="mb-4">
                <p className="text-xs mb-1.5" style={{ color: "var(--slate)" }}>Color</p>
                <div className="flex flex-wrap gap-2">
                  {colors.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => setQuickColorIdx(i)}
                      className="kulto-btn rounded-full shrink-0"
                      style={{ width: 26, height: 26, background: c.hex, border: i === quickColorIdx ? "2px solid var(--sun)" : "1px solid var(--line)" }}
                      title={c.name}
                      aria-label={`Color ${c.name}`}
                    />
                  ))}
                </div>
              </div>
            )}
            {hasSizes && (
              <div className="mb-4">
                <p className="text-xs mb-1.5" style={{ color: "var(--slate)" }}>Talle</p>
                <div className="flex flex-wrap gap-2">
                  {product.sizes.map((s, i) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setQuickSizeIdx(i)}
                      className="kulto-btn text-xs font-semibold rounded-full px-3 py-1.5"
                      style={{ background: quickSizeIdx === i ? "var(--sun)" : "var(--ink-2)", color: quickSizeIdx === i ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)" }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between mb-5">
              <p className="text-xs" style={{ color: "var(--slate)" }}>Cantidad</p>
              <div className="flex items-center gap-2">
                <button type="button" className="kulto-btn p-1.5 rounded-full" onClick={() => setQuickQty((q) => Math.max(1, q - 1))} style={{ color: "var(--bone)" }}><Minus size={14} /></button>
                <span style={{ color: "var(--bone)", minWidth: 16, textAlign: "center" }}>{quickQty}</span>
                <button type="button" className="kulto-btn p-1.5 rounded-full" onClick={() => setQuickQty((q) => Math.min(99, q + 1))} style={{ color: "var(--bone)" }}><Plus size={14} /></button>
              </div>
            </div>
            <button
              onClick={handleQuickAdd}
              disabled={hasSizes && quickSizeIdx === null}
              className="kulto-btn w-full rounded-full py-2 text-sm font-medium whitespace-nowrap"
              style={{
                background: quickJustAdded ? "var(--sun)" : (hasSizes && quickSizeIdx === null) ? "var(--ink-3)" : "var(--signal)",
                color: quickJustAdded ? "var(--ink)" : (hasSizes && quickSizeIdx === null) ? "var(--slate)" : "var(--bone)",
                cursor: (hasSizes && quickSizeIdx === null) ? "default" : "pointer",
              }}
            >
              {quickJustAdded ? "Añadido" : hasSizes && quickSizeIdx === null ? "Elegí un talle" : "Añadir al carrito"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Product configurator (used in modal & in the wizard)               */
/* ------------------------------------------------------------------ */

function ImageLightbox({ image, overlay, background, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.85)" }}
      onClick={onClose}
    >
      <button onClick={onClose} className="kulto-btn absolute top-4 right-4 p-2 rounded-full" style={{ background: "rgba(21,19,26,0.7)", color: "var(--bone)" }}>
        <X size={24} />
      </button>
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md rounded-2xl overflow-hidden flex items-center justify-center"
        style={{ background: background || "var(--ink-3)", aspectRatio: "4 / 5" }}
      >
        <img loading="lazy" src={image} alt="" className="w-full h-full object-contain" />
        {overlay && (
          <img
            src={overlay}
            alt=""
            className="absolute"
            style={{ width: "48%", top: "26%", left: "26%", objectFit: "contain", filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.35))" }}
          />
        )}
      </div>
    </div>
  );
}

// Botón + formulario chico para pedir que avisemos por mail cuando un
// producto sin stock vuelva a tener — aparece en vez del botón de compra
// mientras product.stock esté en 0. Ver notifyRestockSubscribers, que se
// dispara solo al publicar cambios si el stock pasa de 0 a más de 0.
function RestockNotifyForm({ product }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState(null); // null | "sending" | "ok" | "already" | "error"

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || status === "sending") return;
    setStatus("sending");
    try {
      const res = await addRestockSubscriber(product.id, email.trim());
      setStatus(res.already ? "already" : "ok");
    } catch {
      setStatus("error");
    }
  };

  if (status === "ok" || status === "already") {
    return (
      <p className="text-xs mt-3 text-center" style={{ color: "var(--sun)" }}>
        {status === "already" ? "Ya te tenemos anotado — te escribimos apenas vuelva." : "¡Listo! Te avisamos por mail apenas vuelva el stock."}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-2 mt-3">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Tu mail para avisarte"
        className="flex-1 rounded-full px-4 py-2.5 text-sm"
        style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
      />
      <button
        type="submit"
        disabled={status === "sending"}
        className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full shrink-0"
        style={{ background: "var(--signal)", color: "var(--bone)", opacity: status === "sending" ? 0.6 : 1 }}
      >
        Notificarme
      </button>
      {status === "error" && <p className="text-xs" style={{ color: "var(--signal)" }}>No se pudo guardar, probá de nuevo.</p>}
    </form>
  );
}

// Reseñas de ESTE producto puntual (no todas las de la tienda) — usa
// productIds si la reseña ya lo tiene guardado, y si no (reseñas viejas de
// antes de este campo) cae al nombre del producto en items[] como respaldo.
function ProductReviewsBlock({ product, reviews }) {
  const matching = (reviews || []).filter(
    (r) => r.status === "aprobada" && (r.productIds?.includes(product.id) || (!r.productIds && r.items?.includes(product.name)))
  );
  if (!matching.length) return null;
  const avg = matching.reduce((s, r) => s + r.rating, 0) / matching.length;
  return (
    <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="flex items-center gap-3 mb-4">
        <StarRow rating={Math.round(avg)} />
        <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>
          {avg.toFixed(1)} · {matching.length} reseña{matching.length === 1 ? "" : "s"}
        </p>
      </div>
      <div className="flex flex-col gap-4">
        {matching.map((r) => (
          <div key={r.id} className="rounded-2xl p-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
            <StarRow rating={r.rating} />
            <p className="text-sm mt-2" style={{ color: "var(--bone)" }}>{r.text}</p>
            <p className="text-xs mt-2 font-semibold" style={{ color: "var(--slate)" }}>
              {r.name}
              {r.source === "customer" && <span className="ml-1" style={{ color: "var(--sun)" }}>· Compra verificada</span>}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductConfigurator({ product, settings, onAddToCart, compact, reviews = [] }) {
  const [colorIdx, setColorIdx] = useState(0);
  const [imgIdx, setImgIdx] = useState(0);
  const [sizeIdx, setSizeIdx] = useState(0);
  const [designMode, setDesignMode] = useState(product.designs && product.designs.length ? "design" : "custom");
  const [designIdx, setDesignIdx] = useState(0);
  const [customNote, setCustomNote] = useState("");
  const [customImage, setCustomImage] = useState(null);
  const [customImageProcessed, setCustomImageProcessed] = useState(null);
  const [useProcessed, setUseProcessed] = useState(true);
  const [removingBg, setRemovingBg] = useState(false);
  const [qualityAnswer, setQualityAnswer] = useState(null); // null | "yes" | "no"
  const [feedbackSelected, setFeedbackSelected] = useState([]);
  const [qty, setQty] = useState(1);
  const [justAdded, setJustAdded] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const touchStartX = useRef(null);
  const [hoverZoom, setHoverZoom] = useState(false);
  const [zoomOrigin, setZoomOrigin] = useState({ x: 50, y: 50 });

  useEffect(() => {
    setColorIdx(0);
    setImgIdx(0);
    setSizeIdx(0);
    setDesignMode(product.designs && product.designs.length ? "design" : "custom");
    setDesignIdx(0);
    setCustomNote("");
    setCustomImage(null);
    setCustomImageProcessed(null);
    setUseProcessed(true);
    setRemovingBg(false);
    setQualityAnswer(null);
    setFeedbackSelected([]);
    setQty(1);
    setJustAdded(false);
    setZoomOpen(false);
  }, [product.id]);

  useEffect(() => { setImgIdx(0); }, [colorIdx]);

  const color = product.colors && product.colors[colorIdx];
  const images = color ? getColorImages(color) : (product.photoPool || []);
  const activeImage = images[imgIdx] || null;
  const isCover = product.imageFit === "cover";
  const previewBg = product.imageBackground || (color ? color.hex : "var(--ink-3)");
  const hasSizes = product.sizes && product.sizes.length > 0;
  const size = hasSizes ? product.sizes[sizeIdx] : null;
  const design = product.designs && product.designs[designIdx];
  const hasPresetDesigns = product.designs && product.designs.length > 0;
  const allowCustomDesign = product.tags?.customDesign === true;
  // El paso de "elegí tu diseño" solo se muestra si el producto tiene diseños
  // cargados para elegir, o si el admin habilitó que el cliente suba el suyo.
  // Si no, es un producto que se vende tal cual está en la foto.
  const showDesignStep = hasPresetDesigns || allowCustomDesign;
  const unitPrice = product.tags?.oferta && product.salePrice ? product.salePrice : product.price;
  const finalCustomImage = customImage ? (useProcessed && customImageProcessed ? customImageProcessed : customImage) : null;
  // El stock es un número total del producto (no por talle/color todavía), así
  // que cuando llega a 0 bloqueamos la compra entera en vez de un talle puntual.
  const outOfStock = (product.stock ?? 0) <= 0;

  const handleCustomImageUpload = async (file) => {
    if (!file) return;
    const isPng = file.type === "image/png";
    const b64 = await new Promise((resolve) => fileToBase64(file, resolve, 1400, isPng ? 1 : 0.9, isPng ? "image/png" : "image/jpeg"));
    setCustomImage(b64);
    setCustomImageProcessed(null);
    setUseProcessed(true);
    setQualityAnswer(null);
    setFeedbackSelected([]);
    setRemovingBg(true);
    const processed = await removeImageBackground(b64);
    setCustomImageProcessed(processed);
    setUseProcessed(!!processed);
    setRemovingBg(false);
  };

  const toggleFeedbackOption = (opt) => {
    setFeedbackSelected((prev) => (prev.includes(opt) ? prev.filter((o) => o !== opt) : [...prev, opt]));
  };

  const handleAdd = () => {
    const feedbackNote = feedbackSelected.length ? `Pidió cambios: ${feedbackSelected.join(", ")}.` : "";
    const combinedNote = [customNote, feedbackNote].filter(Boolean).join(" ");
    const item = {
      cartId: genId("c"),
      productId: product.id,
      sku: product.sku || product.id,
      name: product.name,
      category: product.category,
      colorName: color ? color.name : "Único",
      colorHex: color ? color.hex : "#999",
      size,
      designName: !showDesignStep
        ? null
        : designMode === "design" && design
        ? design.name
        : `Personalizado${combinedNote ? `: ${combinedNote}` : customImage ? "" : " (a coordinar por WhatsApp)"}`,
      designImage: showDesignStep && designMode === "custom" ? finalCustomImage : null,
      qty,
      unitPrice,
      // Puntos de fidelización de ESTA prenda en particular (null = todavía
      // no se resolvió acá, se usa el general de Ajustes al momento de sumar
      // — ver handleCheckout, que hace lo mismo que ya hacíamos con el precio).
      points: product.points ?? null,
      previewImage: activeImage,
    };
    onAddToCart(item);
    setJustAdded(true);
    setTimeout(() => setJustAdded(false), 2200);
  };

  return (
    <>
    <div className={compact ? "" : "grid md:grid-cols-2 gap-6"}>
      {/* Preview */}
      <div>
        <div
          className="rounded-2xl relative overflow-hidden flex items-center justify-center"
          style={{ background: previewBg, border: "1px solid var(--line)", aspectRatio: "4 / 5" }}
          onTouchStart={(e) => { touchStartX.current = e.touches[0].clientX; }}
          onTouchEnd={(e) => {
            if (touchStartX.current === null || images.length < 2) return;
            const delta = e.changedTouches[0].clientX - touchStartX.current;
            if (delta > 40) setImgIdx((i) => (i - 1 + images.length) % images.length);
            else if (delta < -40) setImgIdx((i) => (i + 1) % images.length);
            touchStartX.current = null;
          }}
          onMouseEnter={() => { if (window.matchMedia?.("(hover: hover)").matches) setHoverZoom(true); }}
          onMouseLeave={() => setHoverZoom(false)}
          onMouseMove={(e) => {
            if (!hoverZoom) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setZoomOrigin({ x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 });
          }}
        >
          {activeImage ? (
            <img
              src={activeImage}
              alt={color?.name}
              className={`w-full h-full ${isCover ? "object-cover" : "object-contain"}`}
              style={{
                transform: hoverZoom ? "scale(2.2)" : "scale(1)",
                transformOrigin: `${zoomOrigin.x}% ${zoomOrigin.y}%`,
                transition: hoverZoom ? "none" : "transform .25s ease",
                cursor: hoverZoom ? "zoom-in" : "default",
              }}
            />
          ) : (
            <Shirt size={64} style={{ color: "rgba(243,239,230,0.35)" }} />
          )}
          {designMode === "design" && design && design.image && (
            <img
              src={design.image}
              alt={design.name}
              className="absolute"
              style={{ width: "48%", top: "26%", left: "26%", objectFit: "contain", filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.35))" }}
            />
          )}
          {designMode === "custom" && finalCustomImage && !removingBg && (
            <img
              src={finalCustomImage}
              alt="Tu diseño"
              className="absolute"
              style={{ width: "48%", top: "26%", left: "26%", objectFit: "contain", filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.35))" }}
            />
          )}
          {images.length > 1 && (
            <>
              <button
                type="button"
                onClick={() => setImgIdx((i) => (i - 1 + images.length) % images.length)}
                className="kulto-btn absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center"
                style={{ background: "rgba(21,19,26,0.6)", color: "var(--bone)" }}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={() => setImgIdx((i) => (i + 1) % images.length)}
                className="kulto-btn absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center"
                style={{ background: "rgba(21,19,26,0.6)", color: "var(--bone)" }}
              >
                <ChevronRight size={18} />
              </button>
              <div className="absolute bottom-3 left-0 right-0 flex items-center justify-center gap-1.5">
                {images.map((_, i) => (
                  <span key={i} className="rounded-full" style={{ width: i === imgIdx ? 14 : 6, height: 6, background: i === imgIdx ? "var(--sun)" : "rgba(243,239,230,0.5)", transition: "width .15s" }} />
                ))}
              </div>
            </>
          )}
          {activeImage && (
            <button
              type="button"
              onClick={() => setZoomOpen(true)}
              className="kulto-btn absolute bottom-3 right-3 w-10 h-10 rounded-full flex items-center justify-center"
              style={{ background: "rgba(21,19,26,0.75)", color: "var(--bone)" }}
              title="Ver foto en grande"
            >
              <ZoomIn size={18} />
            </button>
          )}
        </div>
        {images.length > 1 && (
          <div className="flex gap-2 mt-2 overflow-x-auto kulto-scrollbar pb-1">
            {images.map((img, i) => (
              <button
                key={i}
                onClick={() => setImgIdx(i)}
                className="kulto-btn shrink-0 rounded-lg overflow-hidden"
                style={{ width: 44, height: 44, border: i === imgIdx ? "2px solid var(--sun)" : "1px solid var(--line)", background: "var(--ink-3)" }}
              >
                <img loading="lazy" src={img} className="w-full h-full object-contain" alt="" />
              </button>
            ))}
          </div>
        )}
        <p className="text-xs mt-2" style={{ color: "var(--slate)" }}>
          Vista previa orientativa. El sublimado final puede variar ligeramente.
        </p>
      </div>

      {zoomOpen && activeImage && (
        <ImageLightbox
          image={activeImage}
          overlay={designMode === "design" ? design?.image : null}
          background={previewBg}
          onClose={() => setZoomOpen(false)}
        />
      )}

      {/* Options */}
      <div className="flex flex-col gap-5 mt-5 md:mt-0">
        <div>
          <span className="text-xs" style={{ color: "var(--slate)" }}>{product.category}</span>
          <h3 className="kulto-display text-xl" style={{ color: "var(--bone)" }}>{product.name}</h3>
          <div className="flex items-center gap-2 mt-1">
            {product.tags?.oferta && product.salePrice ? (
              <>
                <span className="font-bold text-lg" style={{ color: "var(--sun)" }}>{formatPrice(product.salePrice)}</span>
                <span className="text-sm line-through" style={{ color: "var(--slate)" }}>{formatPrice(product.price)}</span>
              </>
            ) : (
              <span className="font-bold text-lg" style={{ color: "var(--sun)" }}>{formatPrice(product.price)}</span>
            )}
          </div>
          {settings?.productionTimeNormal && (
            <p className="text-xs mt-1 inline-flex items-center gap-1 rounded-full px-2.5 py-1" style={{ background: "var(--ink-3)", color: "var(--bone)", width: "fit-content" }}>
              <Package size={12} /> Producción en {settings.productionTimeNormal}
            </p>
          )}
          {product.description && (
            <p className="text-sm mt-2" style={{ color: "var(--slate)" }}>{product.description}</p>
          )}
        </div>

        {/* Step 1: color */}
        <div>
          <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>1. Elige el color</p>
          {product.colors && product.colors.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {product.colors.map((c, i) => (
                <ColorSwatch key={i} hex={c.hex} title={c.name} selected={i === colorIdx} onClick={() => setColorIdx(i)} />
              ))}
            </div>
          ) : (
            <p className="text-sm" style={{ color: "var(--slate)" }}>Este producto aún no tiene colores cargados.</p>
          )}
        </div>

        {/* Step 2: size */}
        {hasSizes && (
          <div>
            <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>2. Elige el talle</p>
            <div className="flex flex-wrap gap-2">
              {product.sizes.map((s, i) => (
                <button
                  key={s}
                  onClick={() => setSizeIdx(i)}
                  className="kulto-btn text-sm font-semibold rounded-full"
                  style={{
                    minWidth: 44, padding: "8px 12px",
                    background: i === sizeIdx ? "var(--signal)" : "var(--ink-3)",
                    color: "var(--bone)",
                    border: i === sizeIdx ? "1px solid var(--signal)" : "1px solid var(--line)",
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
            <SizeGuideToggle sizeGuide={product.sizeGuide} sizeGuideImage={product.sizeGuideImage} />
          </div>
        )}

        {/* Step 3: design — solo si el producto tiene diseños para elegir o el
            admin habilitó que el cliente suba el suyo; si no, se vende tal
            cual está en la foto y este paso no aparece. */}
        {showDesignStep && (
        <div>
          <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>{hasSizes ? "3" : "2"}. Elige el diseño</p>
          {hasPresetDesigns && allowCustomDesign && (
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setDesignMode("design")}
              className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
              style={{
                background: designMode === "design" ? "var(--signal)" : "var(--ink-3)",
                color: "var(--bone)",
              }}
            >
              Nuestros diseños
            </button>
            <button
              onClick={() => setDesignMode("custom")}
              className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
              style={{
                background: designMode === "custom" ? "var(--signal)" : "var(--ink-3)",
                color: "var(--bone)",
              }}
            >
              Quiero mi propio diseño
            </button>
          </div>
          )}

          {designMode === "design" ? (
            product.designs && product.designs.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {product.designs.map((d, i) => (
                  <button
                    key={i}
                    onClick={() => setDesignIdx(i)}
                    className="kulto-btn rounded-lg overflow-hidden"
                    style={{
                      width: 54, height: 54,
                      border: i === designIdx ? "2px solid var(--sun)" : "1px solid var(--line)",
                      background: "var(--ink-3)",
                    }}
                    title={d.name}
                  >
                    {d.image && <img loading="lazy" src={d.image} alt={d.name} className="w-full h-full object-contain" />}
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm" style={{ color: "var(--slate)" }}>Aún no hay diseños propios cargados para esta prenda.</p>
            )
          ) : (
            <div className="flex flex-col gap-3">
              {!customImage ? (
                <label
                  className="kulto-btn flex flex-col items-center justify-center gap-2 rounded-xl p-6 text-center cursor-pointer"
                  style={{ background: "var(--ink-3)", border: "1px dashed var(--line)" }}
                >
                  <Upload size={22} style={{ color: "var(--sun)" }} />
                  <span className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Subí tu diseño (PNG o JPG)</span>
                  <span className="text-xs" style={{ color: "var(--slate)" }}>Si tiene fondo, lo intentamos limpiar automáticamente y gratis.</span>
                  <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => handleCustomImageUpload(e.target.files[0])} />
                </label>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="rounded-xl overflow-hidden relative" style={{ aspectRatio: "1 / 1", background: "repeating-conic-gradient(#2a2730 0% 25%, #1e1b24 0% 50%) 0 0 / 20px 20px" }}>
                    {removingBg ? (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2">
                        <Loader2 size={24} className="animate-spin" style={{ color: "var(--sun)" }} />
                        <span className="text-xs" style={{ color: "var(--bone)" }}>Quitando el fondo...</span>
                      </div>
                    ) : (
                      <img loading="lazy" src={finalCustomImage} alt="Tu diseño" className="w-full h-full object-contain p-2" />
                    )}
                  </div>

                  {!removingBg && customImageProcessed && (
                    <div className="flex gap-2">
                      <button
                        onClick={() => setUseProcessed(true)}
                        className="kulto-btn flex-1 text-xs font-semibold rounded-full py-2"
                        style={{ background: useProcessed ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                      >
                        Sin fondo
                      </button>
                      <button
                        onClick={() => setUseProcessed(false)}
                        className="kulto-btn flex-1 text-xs font-semibold rounded-full py-2"
                        style={{ background: !useProcessed ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                      >
                        Foto original
                      </button>
                    </div>
                  )}
                  {!removingBg && !customImageProcessed && (
                    <p className="text-xs" style={{ color: "var(--slate)" }}>No pudimos quitar el fondo automáticamente esta vez — se va a usar la foto tal cual la subiste.</p>
                  )}

                  {!removingBg && (
                    <label className="kulto-btn text-xs font-semibold text-center rounded-full py-2 cursor-pointer" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                      Subir otra foto
                      <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => handleCustomImageUpload(e.target.files[0])} />
                    </label>
                  )}

                  {!removingBg && (
                    <div>
                      <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>¿La imagen quedó como la querés?</p>
                      <div className="flex gap-2">
                        <button
                          onClick={() => { setQualityAnswer("yes"); setFeedbackSelected([]); }}
                          className="kulto-btn flex-1 text-sm font-semibold rounded-full py-2"
                          style={{ background: qualityAnswer === "yes" ? "var(--sun)" : "var(--ink-3)", color: qualityAnswer === "yes" ? "var(--ink)" : "var(--bone)" }}
                        >
                          Sí, así está bien
                        </button>
                        <button
                          onClick={() => setQualityAnswer("no")}
                          className="kulto-btn flex-1 text-sm font-semibold rounded-full py-2"
                          style={{ background: qualityAnswer === "no" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                        >
                          No, quiero ajustar algo
                        </button>
                      </div>
                    </div>
                  )}

                  {qualityAnswer === "no" && (
                    <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--ink-3)" }}>
                      {(settings?.designFeedbackOptions || []).length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {settings.designFeedbackOptions.map((opt) => (
                            <button
                              key={opt}
                              onClick={() => toggleFeedbackOption(opt)}
                              className="kulto-btn text-xs font-semibold rounded-full px-3 py-1.5"
                              style={{
                                background: feedbackSelected.includes(opt) ? "var(--signal)" : "var(--ink-2)",
                                color: "var(--bone)",
                                border: "1px solid var(--line)",
                              }}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      )}
                      <textarea
                        value={customNote}
                        onChange={(e) => setCustomNote(e.target.value)}
                        placeholder="Contanos qué te gustaría cambiar..."
                        rows={2}
                        className="w-full rounded-lg p-2.5 text-sm"
                        style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
                      />
                    </div>
                  )}
                </div>
              )}

              <textarea
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                placeholder="¿Algo más que debamos saber sobre tu diseño? (opcional)"
                rows={2}
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)", display: qualityAnswer === "no" ? "none" : "block" }}
              />

              <p className="text-xs" style={{ color: "var(--sun)" }}>
                Los pedidos personalizados suelen demorar entre 3 y 7 días. Si lo necesitás antes, avisanos por WhatsApp apenas confirmes tu pedido.
              </p>
              {settings?.depositEnabled && (
                <p className="text-xs" style={{ color: "var(--sun)" }}>
                  Para empezar a producirlo pedimos una seña del {settings.depositPercent}% por {settings.depositInfo || "el medio que te indiquemos"}, y el resto al recibirlo.
                </p>
              )}
            </div>
          )}
        </div>
        )}

        {/* Quantity */}
        <div>
          <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Cantidad</p>
          <div className="inline-flex items-center gap-3 rounded-full px-2 py-1" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
            <button className="kulto-btn p-1.5 rounded-full" onClick={() => setQty((q) => Math.max(1, q - 1))} style={{ color: "var(--bone)" }}>
              <Minus size={16} />
            </button>
            <span style={{ color: "var(--bone)", minWidth: 20, textAlign: "center" }}>{qty}</span>
            <button
              className="kulto-btn p-1.5 rounded-full"
              onClick={() => setQty((q) => Math.min(99, q + 1))}
              style={{ color: "var(--bone)" }}
            >
              <Plus size={16} />
            </button>
          </div>
        </div>

        <button
          onClick={handleAdd}
          disabled={outOfStock}
          className="kulto-btn w-full rounded-full py-3 font-semibold flex items-center justify-center gap-2"
          style={{
            background: outOfStock ? "var(--ink-3)" : justAdded ? "var(--sun)" : "var(--signal)",
            color: outOfStock ? "var(--slate)" : justAdded ? "var(--ink)" : "var(--bone)",
            cursor: outOfStock ? "default" : "pointer",
          }}
        >
          {outOfStock ? "Sin stock por ahora" : justAdded ? (<><Check size={18} /> Añadido al carrito</>) : (<><ShoppingBag size={18} /> Añadir al carrito</>)}
        </button>
        {outOfStock && <RestockNotifyForm product={product} />}
      </div>
    </div>
    <ProductReviewsBlock product={product} reviews={reviews} />
    </>
  );
}

/* ------------------------------------------------------------------ */
/*  Product modal                                                      */
/* ------------------------------------------------------------------ */

function RelatedProducts({ product, allProducts, onOpen, favorites, onToggleFavorite }) {
  const related = allProducts.filter((p) => p.category === product.category && p.id !== product.id).slice(0, 6);
  if (!related.length) return null;
  return (
    <div className="mt-8 pt-6" style={{ borderTop: "1px solid var(--line)" }}>
      <p className="text-sm font-semibold mb-3" style={{ color: "var(--bone)" }}>También puede interesarte</p>
      <div className="flex gap-3 overflow-x-auto kulto-scrollbar pb-1">
        {related.map((p) => (
          <div key={p.id} style={{ minWidth: 150, maxWidth: 150 }}>
            <ProductCard product={p} onOpen={onOpen} isFavorite={favorites?.includes(p.id)} onToggleFavorite={onToggleFavorite} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Cuando el mismo diseño se vende en más de una prenda/estilo (ej: la misma
// estampa en la Beagle y en la Oversize, a distinto precio), esto muestra un
// acceso directo entre esas fichas — sin fusionarlas en un solo producto.
function LinkedStyleProducts({ product, allProducts, onOpen, favorites, onToggleFavorite }) {
  if (!product.designGroup) return null;
  const linked = allProducts.filter((p) => p.designGroup === product.designGroup && p.id !== product.id);
  if (!linked.length) return null;
  return (
    <div className="mt-6 pt-6" style={{ borderTop: "1px solid var(--line)" }}>
      <p className="text-sm font-semibold mb-3" style={{ color: "var(--bone)" }}>Este diseño también está disponible en</p>
      <div className="flex gap-3 overflow-x-auto kulto-scrollbar pb-1">
        {linked.map((p) => (
          <div key={p.id} style={{ minWidth: 150, maxWidth: 150 }}>
            <ProductCard product={p} onOpen={onOpen} isFavorite={favorites?.includes(p.id)} onToggleFavorite={onToggleFavorite} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ProductModal({ product, allProducts, settings, onClose, onSwitchProduct, onAddToCart, favorites, onToggleFavorite, reviews, onGoHome, onGoCatalog, onView }) {
  const isFavorite = favorites?.includes(product.id);
  // Cuenta como "vista" cada vez que se abre la ficha de un producto — es la
  // señal (junto a las ventas) que alimenta el "en tendencia" automático.
  useEffect(() => { onView?.(product.id); }, [product.id]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-0 md:p-6"
      style={{ background: "rgba(0,0,0,0.6)" }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full md:max-w-3xl max-h-[92vh] overflow-y-auto kulto-scrollbar rounded-t-3xl md:rounded-3xl p-5 md:p-8"
        style={{ background: "var(--ink)", border: "1px solid var(--line)" }}
      >
        <div className="flex justify-between items-center mb-2">
          {onToggleFavorite ? (
            <button
              onClick={() => onToggleFavorite(product.id)}
              className="kulto-btn text-sm font-semibold flex items-center gap-1.5 px-3 py-1.5 rounded-full"
              style={{ border: "1px solid var(--line)", color: isFavorite ? "var(--signal)" : "var(--slate)" }}
            >
              <Heart size={15} fill={isFavorite ? "var(--signal)" : "none"} /> {isFavorite ? "En tus favoritos" : "Guardar en favoritos"}
            </button>
          ) : <div />}
          <button onClick={onClose} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--slate)" }} aria-label="Cerrar">
            <X size={22} />
          </button>
        </div>
        <Breadcrumbs
          steps={[
            { label: "Inicio", onClick: onGoHome },
            { label: "Catálogo", onClick: onGoCatalog },
            ...(product.category ? [{ label: product.category }] : []),
            { label: product.name },
          ]}
        />
        <ProductConfigurator product={product} settings={settings} onAddToCart={onAddToCart} reviews={reviews} />
        <LinkedStyleProducts product={product} allProducts={allProducts} onOpen={onSwitchProduct} favorites={favorites} onToggleFavorite={onToggleFavorite} />
        <RelatedProducts product={product} allProducts={allProducts} onOpen={onSwitchProduct} favorites={favorites} onToggleFavorite={onToggleFavorite} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Home                                                                */
/* ------------------------------------------------------------------ */

function Hero({ onGoCatalog, onGoWizard, onSearch, heroTitle, heroSubtitle, heroImage, heroImages, banners = [] }) {
  const [query, setQuery] = useState("");
  const submit = (e) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  const activeBanners = (banners || []).filter((b) => b.active !== false && b.placement !== "section");
  const [slide, setSlide] = useState(0);

  useEffect(() => { setSlide(0); }, [activeBanners.length]);

  useEffect(() => {
    if (activeBanners.length < 2) return;
    const t = setInterval(() => setSlide((s) => (s + 1) % activeBanners.length), 5500);
    return () => clearInterval(t);
  }, [activeBanners.length]);

  // Cuando no hay ningún banner activo arriba de todo, la imagen decorativa
  // puede tener varias fotos cargadas — van rotando solas cada tantos
  // segundos, cada una tal cual se subió (sin recortarla ni deformarla).
  const heroImgList = heroImages && heroImages.length ? heroImages : (heroImage ? [heroImage] : []);
  const [heroImgIdx, setHeroImgIdx] = useState(0);
  useEffect(() => { setHeroImgIdx(0); }, [heroImgList.length]);
  useEffect(() => {
    if (activeBanners.length > 0 || heroImgList.length < 2) return;
    const t = setInterval(() => setHeroImgIdx((i) => (i + 1) % heroImgList.length), 4000);
    return () => clearInterval(t);
  }, [activeBanners.length, heroImgList.length]);

  const runCta = (banner) => {
    if (!banner || banner.ctaAction === "none") return;
    if (banner.ctaAction === "wizard") onGoWizard();
    else if (banner.ctaAction === "url" && banner.ctaUrl) window.open(banner.ctaUrl, "_blank", "noreferrer");
    else if (banner.ctaAction === "group" && banner.ctaGroup) onGoCatalog(banner.ctaGroup);
    else onGoCatalog();
  };

  const current = activeBanners.length ? activeBanners[slide % activeBanners.length] : null;
  const title = current ? current.title : heroTitle;
  const subtitle = current ? current.subtitle : heroSubtitle;
  const image = current ? current.image : (heroImgList[heroImgIdx] || null);

  const prevSlide = () => setSlide((s) => (s - 1 + activeBanners.length) % activeBanners.length);
  const nextSlide = () => setSlide((s) => (s + 1) % activeBanners.length);

  return (
    <section className="relative overflow-hidden" style={{ borderBottom: "1px solid var(--line)" }}>
      <div className="max-w-6xl mx-auto px-4 md:px-6 py-14 md:py-24 grid md:grid-cols-2 gap-10 items-center">
        <div>
          <div key={`text-${slide}`} className="kulto-hero-fade">
            <h1 className="kulto-display leading-[0.95] text-4xl sm:text-5xl md:text-6xl whitespace-pre-line" style={{ color: "var(--bone)" }}>
              {title}
            </h1>
            <p className="mt-5 text-base md:text-lg max-w-md" style={{ color: "var(--slate)" }}>
              {subtitle}
            </p>
          </div>
          <form onSubmit={submit} className="mt-6 max-w-sm relative">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2" style={{ color: "var(--slate)" }} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar productos..."
              className="w-full rounded-full pl-10 pr-4 py-3 text-sm"
              style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
            />
          </form>
          <div className="mt-5 flex flex-wrap gap-3">
            {current ? (
              <button onClick={() => runCta(current)} className="kulto-btn rounded-full px-6 py-3 font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                {current.ctaLabel || "Ver catálogo"}
              </button>
            ) : (
              <button onClick={onGoCatalog} className="kulto-btn rounded-full px-6 py-3 font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                Ver catálogo
              </button>
            )}
            <button onClick={onGoWizard} className="kulto-btn rounded-full px-6 py-3 font-semibold flex items-center gap-2" style={{ background: "transparent", color: "var(--bone)", border: "1px solid var(--line)" }}>
              Personalizar mi prenda <ArrowRight size={16} />
            </button>
          </div>
          {activeBanners.length > 1 && (
            <div className="mt-6 flex items-center gap-3">
              <button onClick={prevSlide} aria-label="Banner anterior" className="kulto-btn w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "var(--bone)" }}>
                <ChevronLeft size={14} />
              </button>
              <div className="flex items-center gap-2">
                {activeBanners.map((b, i) => (
                  <button
                    key={b.id || i}
                    onClick={() => setSlide(i)}
                    aria-label={`Banner ${i + 1}`}
                    className="kulto-btn rounded-full"
                    style={{ width: i === slide ? 22 : 8, height: 8, background: i === slide ? "var(--signal)" : "var(--line)", transition: "width .2s" }}
                  />
                ))}
              </div>
              <button onClick={nextSlide} aria-label="Banner siguiente" className="kulto-btn w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "var(--bone)" }}>
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
        <div className="relative h-64 md:h-96 flex items-center justify-center">
          {image ? (
            <img key={`img-${slide}-${heroImgIdx}`} src={image} alt="" className="w-full h-full object-contain kulto-hero-fade" />
          ) : (
            <>
              <div className="absolute rounded-3xl" style={{ width: "70%", height: "70%", background: "var(--ink-2)", border: "1px solid var(--line)", transform: "rotate(-6deg)" }} />
              <div className="absolute rounded-3xl flex items-center justify-center" style={{ width: "58%", height: "58%", background: "var(--signal)", transform: "rotate(8deg)" }}>
                <Shirt size={64} color="var(--bone)" />
              </div>
              <div className="absolute rounded-full px-4 py-2 font-semibold text-sm kulto-display" style={{ top: "6%", right: "8%", background: "var(--sun)", color: "var(--ink)", transform: "rotate(-10deg)" }}>
                Diseños originales
              </div>
              <div className="absolute rounded-full px-4 py-2 font-semibold text-sm kulto-display" style={{ bottom: "8%", left: "2%", background: "var(--bone)", color: "var(--ink)", transform: "rotate(6deg)" }}>
                Pide por WhatsApp
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

// Banner promocional para usar como una sección más del inicio (entre
// "Tendencia", "En oferta", etc.) — no solo arriba de todo como el Hero.
const BANNER_SIZES = { sm: 220, md: 340, lg: 460 };
// Alto de la foto de cada paso en "Crea una prenda única" — el admin elige
// Chico/Mediano/Grande y las tarjetas se agrandan o achican todas juntas,
// siempre del mismo tamaño entre sí (el pie de foto también queda con una
// altura fija de hasta 2 líneas, así ninguna tarjeta queda más alta que
// las demás por tener un texto más largo o no tener texto).
const HOWITWORKS_SIZES = { sm: 90, md: 130, lg: 180 };
// Estilo del recorte para una foto-paso de "Crea una prenda única" según la
// forma elegida — null significa "automática" (no se recorta nada, se
// respeta la proporción real de la foto). Se usa tanto en el panel de
// administrador (para la vista previa) como en el inicio de verdad, así las
// dos quedan siempre idénticas.
function howItWorksShapeBox(shape, size) {
  if (shape === "circular") return { width: size, height: size, borderRadius: "50%" };
  if (shape === "cuadrado") return { width: size, height: size, borderRadius: 12 };
  if (shape === "rectangular") return { width: size * 1.4, height: size, borderRadius: 12 };
  if (shape === "triangular") return { width: size, height: size, clipPath: "polygon(50% 0%, 0% 100%, 100% 100%)" };
  return null;
}
// Recorta y hace zoom de una foto adentro de una caja de tamaño fijo,
// respetando el foco (focalX/focalY) y el zoom guardados — la misma lógica
// se usa acá, en la ventana de "Ajustá la posición" (admin) y en el sitio
// público, así lo que el admin ve siempre es exactamente lo que le queda al
// cliente. Sin zoom (zoom=1) se comporta igual que object-fit: cover.
// Dónde poner el borde de la foto (ya escalada) dentro de la caja: si la foto
// agrandada todavía es más grande que la caja, se recorre el sobrante según
// el foco (0-100%, como antes). Si el admin la achicó tanto que ya entra
// entera, no hay nada para recorrer — se centra sola en vez de quedar pegada
// a una esquina.
function focalOffset(disp, boxSize, focal) {
  if (disp >= boxSize) return -((disp - boxSize) * (focal / 100));
  return (boxSize - disp) / 2;
}
function FocalCropImage({ src, box, focalX = 50, focalY = 50, zoom = 1, alt = "" }) {
  const [natural, setNatural] = useState(null);
  const onLoad = (e) => setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight });
  let imgStyle = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: `${focalX}% ${focalY}%` };
  if (natural && natural.w && natural.h && box?.width && box?.height) {
    const baseScale = Math.max(box.width / natural.w, box.height / natural.h);
    const scale = baseScale * (zoom || 1);
    const dispW = natural.w * scale, dispH = natural.h * scale;
    imgStyle = { position: "absolute", width: dispW, height: dispH, left: focalOffset(dispW, box.width, focalX), top: focalOffset(dispH, box.height, focalY), maxWidth: "none" };
  }
  return (
    <div className="relative overflow-hidden" style={{ ...box, background: "#fff" }}>
      <img loading="lazy" src={src} alt={alt} onLoad={onLoad} draggable={false} className="pointer-events-none" style={imgStyle} />
    </div>
  );
}
const BANNER_FOCUS_POSITIONS = { center: "center center", top: "center top", bottom: "center bottom", left: "left center", right: "right center" };

function PromoBanner({ banner, onGoCatalog, onGoWizard }) {
  if (!banner || banner.active === false) return null;

  const clickable = banner.ctaAction && banner.ctaAction !== "none";
  const objectPosition = BANNER_FOCUS_POSITIONS[banner.focus] || "center center";

  const runCta = () => {
    if (!clickable) return;
    if (banner.ctaAction === "wizard") onGoWizard();
    else if (banner.ctaAction === "url" && banner.ctaUrl) window.open(banner.ctaUrl, "_blank", "noreferrer");
    else if (banner.ctaAction === "group" && banner.ctaGroup) onGoCatalog(banner.ctaGroup);
    else onGoCatalog();
  };

  const interactiveProps = clickable
    ? {
        role: "button",
        tabIndex: 0,
        onClick: runCta,
        onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); runCta(); } },
      }
    : {};

  if (banner.layout === "tile") {
    const minHeight = BANNER_SIZES[banner.size] || BANNER_SIZES.md;
    return (
      <div
        {...interactiveProps}
        className={`kulto-banner-tile relative rounded-2xl overflow-hidden flex items-end ${clickable ? "cursor-pointer kulto-banner-clickable" : ""}`}
        style={{ minHeight, background: "var(--ink-3)", border: "1px solid var(--line)", "--banner-glow": banner.highlightColor || "transparent" }}
      >
        {banner.image && (
          <img
            src={banner.image}
            alt=""
            className="kulto-banner-tile-img absolute inset-0 w-full h-full object-cover"
            style={{ objectPosition }}
          />
        )}
        <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(21,19,26,0) 45%, rgba(21,19,26,0.88))" }} />
        <div className="relative w-full p-5 flex flex-col gap-1">
          {banner.title && (
            <h3 className="kulto-display text-xl md:text-2xl leading-[0.95] whitespace-pre-line" style={{ color: "var(--bone)" }}>
              {banner.title}
            </h3>
          )}
          {banner.subtitle && <p className="text-xs md:text-sm" style={{ color: "var(--bone)" }}>{banner.subtitle}</p>}
        </div>
      </div>
    );
  }

  const minHeight = BANNER_SIZES[banner.size] || BANNER_SIZES.md;
  // Los banners "ancho del catálogo" van dentro del mismo contenedor angosto
  // que el resto de las secciones (no de punta a punta como los otros), así
  // que quedan como un rectángulo suelto al lado de tarjetas redondeadas —
  // el admin puede elegir que también lleven las puntas redondeadas para
  // que combinen con el resto del estilo.
  const rounded = banner.layout === "row" && banner.roundedCorners;

  return (
    <section
      {...interactiveProps}
      className={`kulto-banner-tile relative w-full overflow-hidden flex items-center ${rounded ? "rounded-2xl" : ""} ${clickable ? "cursor-pointer kulto-banner-clickable" : ""}`}
      style={{ minHeight, background: "var(--ink-2)", border: rounded ? "1px solid var(--line)" : "none", "--banner-glow": banner.highlightColor || "transparent" }}
    >
      {banner.image && (
        <img
          src={banner.image}
          alt=""
          className="kulto-banner-tile-img absolute inset-0 w-full h-full object-cover"
          style={{ objectPosition }}
        />
      )}
      {banner.image && (
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(21,19,26,0.88) 30%, rgba(21,19,26,0.15))" }} />
      )}
      <div className="relative w-full max-w-6xl mx-auto px-4 md:px-6 py-10">
        <div className="flex flex-col gap-3 max-w-lg">
          {banner.title && (
            <h3 className="kulto-display text-2xl md:text-4xl leading-[0.95] whitespace-pre-line" style={{ color: "var(--bone)" }}>
              {banner.title}
            </h3>
          )}
          {banner.subtitle && <p className="text-sm md:text-base" style={{ color: "var(--bone)" }}>{banner.subtitle}</p>}
          {clickable && (
            <span className="kulto-btn rounded-full px-6 py-3 font-semibold w-fit mt-1 inline-block" style={{ background: "var(--signal)", color: "var(--bone)" }}>
              {banner.ctaLabel || "Ver catálogo"}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

function HorizontalRow({ products, onOpen, favorites, onToggleFavorite, onAddToCart }) {
  return (
    <div className="flex gap-4 overflow-x-auto kulto-scrollbar pb-2 -mx-4 px-4 md:mx-0 md:px-0">
      {products.map((p) => (
        <div key={p.id} style={{ minWidth: 220, maxWidth: 220 }}>
          <ProductCard product={p} onOpen={onOpen} isFavorite={favorites?.includes(p.id)} onToggleFavorite={onToggleFavorite} onAddToCart={onAddToCart} />
        </div>
      ))}
    </div>
  );
}

function StarRow({ rating }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} size={14} fill={n <= rating ? "var(--sun)" : "none"} color="var(--sun)" />
      ))}
    </div>
  );
}

function ReviewsCarousel({ reviews }) {
  const trackRef = useRef(null);
  const scroll = (dir) => {
    if (!trackRef.current) return;
    trackRef.current.scrollBy({ left: dir * 280, behavior: "smooth" });
  };
  const visible = reviews.filter((r) => r.status === "aprobada");

  return (
    <section>
      <SectionTitle
        eyebrow="Nuestros clientes"
        title="Lo que dicen de Kulto"
        action={
          visible.length > 0 && (
            <div className="hidden md:flex gap-2">
              <button onClick={() => scroll(-1)} className="kulto-btn w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "var(--bone)" }}>
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => scroll(1)} className="kulto-btn w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "var(--bone)" }}>
                <ChevronRight size={16} />
              </button>
            </div>
          )
        }
      />
      {visible.length > 0 ? (
        <div ref={trackRef} className="flex gap-4 overflow-x-auto kulto-scrollbar pb-2 -mx-4 px-4 md:mx-0 md:px-0">
          {visible.map((r) => (
            <div
              key={r.id}
              className="rounded-2xl p-5 flex flex-col gap-3 shrink-0"
              style={{ width: 260, background: "var(--ink-2)", border: "1px solid var(--line)" }}
            >
              {r.photo ? (
                <div className="w-full rounded-xl overflow-hidden" style={{ aspectRatio: "4 / 5", background: "var(--ink-3)" }}>
                  <img loading="lazy" src={r.photo} className="w-full h-full object-cover" alt={`Foto de ${r.name}`} />
                </div>
              ) : (
                <Quote size={20} style={{ color: "var(--signal)" }} />
              )}
              <StarRow rating={r.rating} />
              <p className="text-sm flex-1" style={{ color: "var(--bone)" }}>{r.text}</p>
              <div>
                <p className="text-xs font-semibold" style={{ color: "var(--slate)" }}>{r.name}</p>
                {r.source === "customer" && r.items?.length > 0 && (
                  <p className="text-xs mt-0.5 flex items-center gap-1" style={{ color: "var(--sun)" }}>
                    <Check size={11} /> Compra verificada · {r.items[0]}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="rounded-2xl p-6 flex flex-col items-center text-center gap-2"
          style={{ background: "var(--ink-2)", border: "1px dashed var(--line)" }}
        >
          <Quote size={22} style={{ color: "var(--slate)" }} />
          <p className="text-sm" style={{ color: "var(--bone)" }}>Todavía no tenemos reseñas — ¡sé el primero en contarnos qué te pareció!</p>
          <p className="text-xs" style={{ color: "var(--slate)" }}>Buscá tu pedido en "Mi pedido" para dejar la tuya.</p>
        </div>
      )}
    </section>
  );
}

// Tira de fotos de "trabajos personalizados" (pedidos reales ya hechos) para
// mostrar cerca de "Personalizar" en el inicio — desliza de a varias fotos
// (3 o 4 según el ancho de pantalla) con flechas y también arrastrando/
// deslizando con el dedo en el celular (scroll horizontal nativo).
function CustomWorkCarousel({ items = [], speed = 0.5 }) {
  const trackRef = useRef(null);
  const pausedRef = useRef(false);
  // Posición "real" del scroll, en un ref para que tanto el loop de abajo
  // como resume() la lean/escriban sin depender de un cierre viejo.
  const posRef = useRef(0);
  // En un ref para que el loop de abajo (que no se reinicia solo por esto)
  // siempre lea el valor más nuevo sin tener que recrear el requestAnimationFrame.
  const speedRef = useRef(speed);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  // Duplicamos el estado de pausa en un state (además del ref que usa el loop
  // de animación) solo para poder desactivar el scroll-snap mientras se
  // desliza solo — con el snap prendido, el navegador "peleaba" con cada
  // empujoncito de 0.5px y el carrusel quedaba visualmente quieto. Al pausarlo
  // (mouse/touch encima, o con los botones) volvemos a activar el snap para
  // que se sienta prolijo al soltar o al usar las flechas.
  const [isPaused, setIsPaused] = useState(false);
  const [lightboxItem, setLightboxItem] = useState(null);
  const scroll = (dir) => {
    if (!trackRef.current) return;
    const cardWidth = trackRef.current.firstChild ? trackRef.current.firstChild.offsetWidth + 16 : 260;
    trackRef.current.scrollBy({ left: dir * cardWidth * 2, behavior: "smooth" });
  };

  // Desliza solo, despacio, hacia la derecha y vuelve al principio al llegar
  // al final — se detiene mientras el mouse está encima (o mientras se toca,
  // en el celular) para no pelear con el usuario si quiere mirar o deslizar.
  useEffect(() => {
    const track = trackRef.current;
    if (!track || items.length < 2) return;
    // Guardamos la posición "real" (con decimales) acá en vez de leerla de
    // vuelta de track.scrollLeft en cada cuadro: el navegador redondea ese
    // valor a un número entero de píxeles, así que con velocidades bajas
    // (menos de 1px por cuadro) cada sumita se perdía al redondear y el
    // carrusel quedaba visualmente quieto en "Lento" — nunca llegaba a
    // acumular ni un píxel entero. Sumando sobre esta variable en vez de
    // sobre el valor ya redondeado, el movimiento es parejo a cualquier
    // velocidad, por lenta que sea.
    posRef.current = track.scrollLeft;
    let raf;
    const step = () => {
      if (!pausedRef.current) {
        const maxScroll = track.scrollWidth - track.clientWidth;
        // Si el carrusel todavía no terminó de acomodar su layout (por ej. las
        // fotos recién se están cargando, o la sección se acaba de volver a
        // mostrar al navegar), maxScroll puede salir 0/negativo o gigante por
        // un instante — en ese caso no tocamos el scroll para no "tirarlo" a
        // una posición rara que deje todo fuera de vista.
        if (Number.isFinite(maxScroll) && maxScroll > 1 && maxScroll < 100000) {
          posRef.current = posRef.current >= maxScroll - 1 ? 0 : posRef.current + speedRef.current;
          track.scrollLeft = posRef.current;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [items.length]);

  const pause = () => { pausedRef.current = true; setIsPaused(true); };
  const resume = () => {
    // Si mientras estaba pausado el navegador movió el scroll de verdad (el
    // snap del CSS, o el usuario arrastrando o usando las flechas), nuestra
    // cuenta interna quedó vieja — la sincronizamos acá para seguir desde
    // donde está en pantalla ahora, no desde antes de pausarlo (eso era lo
    // que hacía que pareciera "reiniciar" al sacar el mouse).
    if (trackRef.current) posRef.current = trackRef.current.scrollLeft;
    pausedRef.current = false;
    setIsPaused(false);
  };

  if (!items.length) return null;

  return (
    <section>
      <SectionTitle
        eyebrow="Hecho por Kulto"
        title="Trabajos personalizados"
        action={
          items.length > 3 && (
            <div className="hidden md:flex gap-2" onMouseEnter={pause} onMouseLeave={resume}>
              <button onClick={() => scroll(-1)} className="kulto-btn w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "var(--bone)" }} aria-label="Ver anteriores">
                <ChevronLeft size={16} />
              </button>
              <button onClick={() => scroll(1)} className="kulto-btn w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "var(--bone)" }} aria-label="Ver siguientes">
                <ChevronRight size={16} />
              </button>
            </div>
          )
        }
      />
      <div
        ref={trackRef}
        onMouseEnter={pause}
        onMouseLeave={resume}
        onTouchStart={pause}
        onTouchEnd={() => setTimeout(resume, 1800)}
        className="flex gap-4 overflow-x-auto kulto-scrollbar pb-2 -mx-4 px-4 md:mx-0 md:px-0"
        style={{ scrollSnapType: isPaused ? "x proximity" : "none" }}
      >
        {items.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => { pause(); setLightboxItem(it); }}
            className="kulto-btn text-left rounded-2xl overflow-hidden shrink-0 flex flex-col w-[70%] sm:w-[45%] md:w-[31%] lg:w-[23%]"
            style={{ background: "var(--ink-2)", border: "1px solid var(--line)", scrollSnapAlign: "start" }}
          >
            <div style={{ aspectRatio: "4 / 5", background: "var(--ink-3)" }}>
              <img loading="lazy" src={it.image} className="w-full h-full object-cover" alt={it.caption || "Trabajo personalizado"} />
            </div>
            {it.caption && (
              <p className="text-xs p-3" style={{ color: "var(--slate)" }}>{it.caption}</p>
            )}
          </button>
        ))}
      </div>
      {lightboxItem && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.9)", zIndex: 200 }}
          onClick={() => { setLightboxItem(null); resume(); }}
        >
          <div className="relative max-w-2xl w-full" onClick={(e) => e.stopPropagation()}>
            <img
              src={lightboxItem.image}
              alt={lightboxItem.caption || "Trabajo personalizado"}
              className="w-full max-h-[80vh] object-contain rounded-2xl mx-auto"
            />
            {lightboxItem.caption && (
              <p className="text-sm text-center mt-3" style={{ color: "#fff" }}>{lightboxItem.caption}</p>
            )}
            <button
              type="button"
              onClick={() => { setLightboxItem(null); resume(); }}
              className="kulto-btn absolute -top-3 -right-3 rounded-full p-2"
              style={{ background: "var(--ink)", border: "1px solid var(--line)", color: "#fff" }}
              aria-label="Cerrar vista ampliada"
              title="Cerrar"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Home({ products, settings, reviews, customWorkGallery, onOpen, onGoCatalog, onGoWizard, onSearch, favorites, onToggleFavorite, onAddToCart }) {
  // Un mismo diseño puede repetirse en varias prendas (mismo designGroup) —
  // si por error quedaron varias copias con la misma etiqueta ("más
  // vendido", "oferta", "tendencia"), acá se muestra una sola tarjeta por
  // diseño en cada fila, para no repetir el mismo diseño varias veces.
  const dedupeByDesign = (list) => {
    const seen = new Set();
    return list.filter((p) => {
      if (!p.designGroup) return true;
      if (seen.has(p.designGroup)) return false;
      seen.add(p.designGroup);
      return true;
    });
  };
  const bestsellers = dedupeByDesign(products.filter((p) => p.tags?.bestseller));
  const ofertas = dedupeByDesign(products.filter((p) => p.tags?.oferta));
  const trendingIds = computeTrendingIds(products, settings);
  const tendencia = dedupeByDesign(products.filter((p) => p.tags?.tendencia || trendingIds.has(p.id)));

  const sectionOrder = getEffectiveHomeSections(settings);

  const renderSection = (key) => {
    if (key.startsWith("banner:")) {
      const bannerId = key.slice(7);
      const banner = (settings.banners || []).find((b) => b.id === bannerId);
      if (!banner) return null;
      return <PromoBanner key={key} banner={banner} onGoCatalog={onGoCatalog} onGoWizard={onGoWizard} />;
    }
    switch (key) {
      case "bestsellers":
        return (
          <section key="bestsellers">
            <SectionTitle eyebrow="Los favoritos" title="Lo más vendido" />
            {bestsellers.length ? (
              <HorizontalRow products={bestsellers} onOpen={onOpen} favorites={favorites} onToggleFavorite={onToggleFavorite} onAddToCart={onAddToCart} />
            ) : (
              <EmptyState text="Aún no hay productos marcados como más vendidos. Márcalos desde el panel de administrador." />
            )}
          </section>
        );
      case "ofertas":
        return (
          <section key="ofertas">
            <SectionTitle eyebrow="Por tiempo limitado" title="En oferta" />
            {ofertas.length ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {ofertas.map((p) => <ProductCard key={p.id} product={p} onOpen={onOpen} isFavorite={favorites?.includes(p.id)} onToggleFavorite={onToggleFavorite} onAddToCart={onAddToCart} />)}
              </div>
            ) : (
              <EmptyState text="Todavía no hay ofertas activas." />
            )}
          </section>
        );
      case "tendencia":
        return (
          <section key="tendencia">
            <SectionTitle eyebrow="Lo que se lleva" title="Tendencia" />
            {tendencia.length ? (
              <HorizontalRow products={tendencia} onOpen={onOpen} favorites={favorites} onToggleFavorite={onToggleFavorite} onAddToCart={onAddToCart} />
            ) : (
              <EmptyState text="Todavía no hay productos en tendencia." />
            )}
          </section>
        );
      case "cta": {
        const steps = settings.howItWorksSteps || [];
        const ctaShape = settings.howItWorksImageShape || "auto";
        const ctaSize = HOWITWORKS_SIZES[settings.howItWorksCardSize] || HOWITWORKS_SIZES.md;
        const ctaShapeBox = howItWorksShapeBox(ctaShape, ctaSize);
        return (
          <section
            key="cta"
            className="rounded-3xl p-8 md:p-12 flex flex-col gap-8"
            style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
          >
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
              <div>
                <h3 className="kulto-display text-2xl md:text-3xl" style={{ color: "var(--bone)" }}>Crea una prenda única</h3>
                <p className="mt-2 max-w-md" style={{ color: "var(--slate)" }}>Elige la prenda, el color y sublima tu propio diseño en tres pasos.</p>
              </div>
              <button onClick={onGoWizard} className="kulto-btn rounded-full px-6 py-3 font-semibold flex items-center gap-2 shrink-0" style={{ background: "var(--sun)", color: "var(--ink)" }}>
                Empezar <ArrowRight size={16} />
              </button>
            </div>
            {steps.length > 0 && (
              // Antes cada tarjeta ocupaba una columna pareja del grid, así que
              // una foto angosta quedaba nadando en medio de mucho espacio
              // vacío. Ahora es una fila que se arma sola: cada tarjeta mide
              // lo que mide su propia foto (alto fijo, ancho según la imagen),
              // así las 4 quedan del mismo alto y alineadas en la fila, sin el
              // espacio negro de sobra a los costados.
              <div className="flex flex-wrap items-start justify-center gap-4">
                {steps.map((s, i) => (
                  // Sin forma elegida: tarjeta rectangular de fondo oscuro, como
                  // siempre. Con forma elegida (círculo, cuadrado redondeado,
                  // triángulo): SIN tarjeta ni fondo alrededor — antes, aunque la
                  // caja de la foto ya era circular, la tarjeta que la envolvía
                  // seguía siendo rectangular y su fondo se asomaba en las 4
                  // puntas alrededor del círculo, dando la sensación de que
                  // seguía "cuadrado". Ahora, con forma, solo queda la foto
                  // recortada con esa forma y el texto debajo, sin caja detrás.
                  <div key={s.id} className={ctaShapeBox ? "flex flex-col items-center" : "rounded-2xl overflow-hidden flex flex-col"} style={ctaShapeBox ? {} : { background: "var(--ink-3)", border: "1px solid var(--line)" }}>
                    <div className="relative flex items-center justify-center shrink-0" style={ctaShapeBox ? { ...ctaShapeBox } : { height: ctaSize, width: ctaSize, background: "var(--ink)", alignSelf: "flex-start" }}>
                      {s.image ? (
                        ctaShapeBox ? (
                          <FocalCropImage
                            src={s.image}
                            box={ctaShapeBox}
                            focalX={s.focalX ?? 50}
                            focalY={s.focalY ?? 50}
                            zoom={s.focalZoom ?? 1}
                            alt={s.caption || `Paso ${i + 1}`}
                          />
                        ) : (
                          <img loading="lazy" src={s.image} className="h-full w-auto object-contain" style={{ maxWidth: "70vw" }} alt={s.caption || `Paso ${i + 1}`} />
                        )
                      ) : (
                        <Shirt size={28} color="rgba(243,239,230,0.4)" />
                      )}
                      <span className="absolute top-2 left-2 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold" style={{ background: "var(--sun)", color: "var(--ink)" }}>
                        {i + 1}
                      </span>
                    </div>
                    {s.caption && (
                      <p
                        className="text-xs p-3 text-center"
                        style={{
                          color: "var(--slate)",
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {s.caption}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      }
      case "customwork":
        return <CustomWorkCarousel key="customwork" items={customWorkGallery || []} speed={settings.customWorkSpeed} />;
      case "reviews":
        return <ReviewsCarousel key="reviews" reviews={reviews} />;
      default:
        return null;
    }
  };

  // Los banners "de punta a punta" ocupan toda la pantalla (como en adidas.es);
  // los banners "tarjeta" se agrupan entre sí en una fila tipo grilla, del
  // ancho normal de la web, del tamaño de las cajas de producto; el resto de
  // las secciones respeta el ancho normal de la web.
  const visibleSections = sectionOrder.filter((s) => s.visible !== false);
  const bannerLayoutOf = (key) => {
    const banner = (settings.banners || []).find((b) => b.id === key.slice(7));
    if (banner?.layout === "tile") return "tile";
    if (banner?.layout === "row") return "row";
    return "full";
  };
  const renderGroups = [];
  for (let i = 0; i < visibleSections.length; i++) {
    const s = visibleSections[i];
    if (s.key.startsWith("banner:") && bannerLayoutOf(s.key) === "tile") {
      const group = [s];
      while (i + 1 < visibleSections.length && visibleSections[i + 1].key.startsWith("banner:") && bannerLayoutOf(visibleSections[i + 1].key) === "tile") {
        group.push(visibleSections[++i]);
      }
      renderGroups.push({ type: "tiles", keys: group.map((g) => g.key) });
    } else {
      renderGroups.push({ type: "single", key: s.key });
    }
  }

  return (
    <div>
      <Hero onGoCatalog={onGoCatalog} onGoWizard={onGoWizard} onSearch={onSearch} heroTitle={settings.heroTitle} heroSubtitle={settings.heroSubtitle} heroImage={settings.heroImage} heroImages={settings.heroImages} banners={settings.banners} />

      <div className="flex flex-col gap-14 py-12">
        {renderGroups.map((g) => {
          if (g.type === "tiles") {
            const contents = g.keys.map((key) => renderSection(key)).filter(Boolean);
            if (!contents.length) return null;
            return (
              <div key={g.keys.join("|")} className="max-w-6xl mx-auto px-4 md:px-6 w-full">
                <div className={`grid gap-4 ${contents.length >= 3 ? "grid-cols-2 md:grid-cols-3" : "grid-cols-1 md:grid-cols-2"}`}>
                  {contents}
                </div>
              </div>
            );
          }
          const content = renderSection(g.key);
          if (!content) return null;
          // Los banners "de punta a punta" van sin el contenedor, para que
          // lleguen a los bordes reales de la pantalla. Los "ancho del
          // catálogo" sí llevan el mismo contenedor que el resto de las
          // secciones, para quedar exactamente del ancho de la grilla de
          // productos (ni más angostos ni más anchos que ella).
          if (g.key.startsWith("banner:") && bannerLayoutOf(g.key) === "full") return content;
          return (
            <div key={g.key} className="max-w-6xl mx-auto px-4 md:px-6 w-full">
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Catalog                                                             */
/* ------------------------------------------------------------------ */

function Catalog({ products, categories, groups, onOpen, initialQuery, initialGroup, initialCategory, favorites, onToggleFavorite, onlyFavorites = false, onGoHome, onAddToCart }) {
  const [activeGroup, setActiveGroup] = useState(initialGroup || "Todas");
  const [activeCat, setActiveCat] = useState(initialCategory || "Todas");
  const [query, setQuery] = useState(initialQuery || "");
  const [sortBy, setSortBy] = useState("relevancia");
  const [showFilters, setShowFilters] = useState(false);
  const [priceMin, setPriceMin] = useState("");
  const [priceMax, setPriceMax] = useState("");
  const [selectedSizes, setSelectedSizes] = useState([]);
  const [selectedColors, setSelectedColors] = useState([]);

  const priceOf = (p) => (p.tags?.oferta && p.salePrice ? p.salePrice : p.price);
  if (onlyFavorites) products = products.filter((p) => favorites?.includes(p.id));

  let filtered = activeGroup === "Todas" ? products : products.filter((p) => (p.group || "") === activeGroup);
  const catsInGroup = [...new Set(filtered.map((p) => p.category))].filter(Boolean);
  filtered = activeCat === "Todas" ? filtered : filtered.filter((p) => p.category === activeCat);
  // Un mismo diseño puede estar disponible en varias prendas a la vez
  // (comparten designGroup, ver "Modelos donde está disponible" / "Vincular
  // con otro estilo" en el admin) — acá se muestra una sola tarjeta por
  // diseño en vez de una repetida por cada prenda; el resto de los modelos
  // donde también está se eligen adentro de la ficha del producto.
  const seenDesignGroups = new Set();
  filtered = filtered.filter((p) => {
    if (!p.designGroup) return true;
    if (seenDesignGroups.has(p.designGroup)) return false;
    seenDesignGroups.add(p.designGroup);
    return true;
  });
  if (query.trim()) {
    const q = query.trim().toLowerCase();
    filtered = filtered.filter((p) => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q));
  }

  // Talles y colores para mostrar como opciones — solo los que existen dentro
  // de lo que ya quedó filtrado por grupo/categoría/búsqueda, para no ofrecer
  // opciones que de todos modos no van a traer ningún resultado.
  const availableSizes = [...new Set(filtered.flatMap((p) => p.sizes || []))];
  const availableColors = [];
  const seenColorKeys = new Set();
  filtered.forEach((p) => (p.colors || []).forEach((c) => {
    const key = (c.name || "").toLowerCase();
    if (key && !seenColorKeys.has(key)) { seenColorKeys.add(key); availableColors.push({ name: c.name, hex: c.hex }); }
  }));

  const minP = priceMin.trim() ? Number(priceMin) : null;
  const maxP = priceMax.trim() ? Number(priceMax) : null;
  if (minP !== null && !Number.isNaN(minP)) filtered = filtered.filter((p) => priceOf(p) >= minP);
  if (maxP !== null && !Number.isNaN(maxP)) filtered = filtered.filter((p) => priceOf(p) <= maxP);
  if (selectedSizes.length) filtered = filtered.filter((p) => (p.sizes || []).some((s) => selectedSizes.includes(s)));
  if (selectedColors.length) filtered = filtered.filter((p) => (p.colors || []).some((c) => selectedColors.includes((c.name || "").toLowerCase())));

  filtered = [...filtered];
  if (sortBy === "precio-asc") filtered.sort((a, b) => priceOf(a) - priceOf(b));
  else if (sortBy === "precio-desc") filtered.sort((a, b) => priceOf(b) - priceOf(a));
  else if (sortBy === "nombre") filtered.sort((a, b) => a.name.localeCompare(b.name));
  else if (sortBy === "reciente") filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  else if (sortBy === "vendido") filtered.sort((a, b) => (b.salesCount || 0) - (a.salesCount || 0));

  const toggleSize = (s) => setSelectedSizes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const toggleColor = (name) => {
    const key = name.toLowerCase();
    setSelectedColors((prev) => (prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key]));
  };
  const activeFilterCount = (minP !== null ? 1 : 0) + (maxP !== null ? 1 : 0) + selectedSizes.length + selectedColors.length;
  const clearFilters = () => { setPriceMin(""); setPriceMax(""); setSelectedSizes([]); setSelectedColors([]); };
  const filterInputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 py-10">
      <Breadcrumbs
        steps={[
          { label: "Inicio", onClick: onGoHome },
          { label: onlyFavorites ? "Favoritos" : "Catálogo" },
          ...(activeGroup !== "Todas" ? [{ label: activeGroup }] : []),
        ]}
      />
      <SectionTitle eyebrow={onlyFavorites ? "Guardado por vos" : "Todo Kulto"} title={onlyFavorites ? "Tus favoritos" : "Catálogo"} />

      <div className="flex flex-col sm:flex-row gap-2 mb-4">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar productos..."
          className="flex-1 rounded-xl p-2.5 text-sm"
          style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value)}
          className="rounded-xl p-2.5 text-sm"
          style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
        >
          <option value="relevancia">Orden: relevancia</option>
          <option value="vendido">Más vendido</option>
          <option value="reciente">Más reciente</option>
          <option value="precio-asc">Precio: menor a mayor</option>
          <option value="precio-desc">Precio: mayor a menor</option>
          <option value="nombre">Nombre A-Z</option>
        </select>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className="kulto-btn rounded-xl px-4 py-2.5 text-sm font-semibold flex items-center justify-center gap-2 shrink-0"
          style={{ background: activeFilterCount > 0 ? "var(--signal)" : "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
        >
          <SlidersHorizontal size={16} /> Filtros{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
        </button>
      </div>

      {showFilters && (
        <div className="rounded-2xl p-4 mb-4 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <div>
            <p className="text-xs font-semibold mb-2" style={{ color: "var(--bone)" }}>Precio</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
                placeholder="Mín"
                className="w-24 rounded-lg p-2 text-sm"
                style={filterInputStyle}
              />
              <span style={{ color: "var(--slate)" }}>—</span>
              <input
                type="number"
                min="0"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                placeholder="Máx"
                className="w-24 rounded-lg p-2 text-sm"
                style={filterInputStyle}
              />
            </div>
          </div>
          {availableSizes.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: "var(--bone)" }}>Talle</p>
              <div className="flex flex-wrap gap-2">
                {availableSizes.map((s) => (
                  <button
                    key={s}
                    onClick={() => toggleSize(s)}
                    className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
                    style={{ background: selectedSizes.includes(s) ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {availableColors.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: "var(--bone)" }}>Color</p>
              <div className="flex flex-wrap gap-2">
                {availableColors.map((c) => {
                  const key = (c.name || "").toLowerCase();
                  const active = selectedColors.includes(key);
                  return (
                    <button
                      key={key}
                      onClick={() => toggleColor(c.name)}
                      title={c.name}
                      className="kulto-btn w-8 h-8 rounded-full flex items-center justify-center"
                      style={{ background: c.hex, border: active ? "2px solid var(--sun)" : "1px solid var(--line)" }}
                    >
                      {active && <Check size={14} color="#fff" style={{ filter: "drop-shadow(0 0 2px rgba(0,0,0,0.8))" }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {activeFilterCount > 0 && (
            <button onClick={clearFilters} className="kulto-btn text-xs font-semibold flex items-center gap-1.5 w-fit" style={{ color: "var(--signal)" }}>
              <RotateCcw size={13} /> Limpiar filtros
            </button>
          )}
        </div>
      )}

      {groups.length > 0 && (
        <div className="flex gap-2 overflow-x-auto kulto-scrollbar pb-3 mb-2">
          {["Todas", ...groups].map((g) => (
            <button
              key={g}
              onClick={() => { setActiveGroup(g); setActiveCat("Todas"); }}
              className="kulto-btn shrink-0 text-sm font-semibold px-4 py-2 rounded-full"
              style={{
                background: activeGroup === g ? "var(--sun)" : "var(--ink-2)",
                color: activeGroup === g ? "var(--ink)" : "var(--bone)",
                border: "1px solid var(--line)",
              }}
            >
              {g}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 overflow-x-auto kulto-scrollbar pb-3 mb-6">
        {["Todas", ...catsInGroup].map((c) => (
          <button
            key={c}
            onClick={() => setActiveCat(c)}
            className="kulto-btn shrink-0 text-sm font-semibold px-4 py-2 rounded-full"
            style={{
              background: activeCat === c ? "var(--signal)" : "var(--ink-2)",
              color: "var(--bone)",
              border: "1px solid var(--line)",
            }}
          >
            {c}
          </button>
        ))}
      </div>
      {filtered.length ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filtered.map((p) => <ProductCard key={p.id} product={p} onOpen={onOpen} isFavorite={favorites?.includes(p.id)} onToggleFavorite={onToggleFavorite} onAddToCart={onAddToCart} />)}
        </div>
      ) : (
        <EmptyState text={onlyFavorites ? "Todavía no guardaste ningún producto — tocá el corazón en cualquier producto para guardarlo acá." : "No hay productos en esta categoría todavía."} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Wizard (Personalizar)                                               */
/* ------------------------------------------------------------------ */

/* Interactive placer: lets the customer drag/resize/rotate AS MANY uploaded
   images as they want over a fixed garment photo (front or back). `designs`
   is an array of { id, image, x, y, widthPct, rotation } layers — x/y are %
   of the container (the image's center), widthPct is the image's width as a
   fraction of the container's width, rotation is in degrees. `setDesigns`
   lifts the whole array up so the parent Wizard keeps front and back
   independent. Tap a layer to select it (shows its handles + a size/rotation
   slider + a remove button); drag the layer to move it, its corner handle to
   resize it, and its top handle to rotate it freely. */
function DesignPlacer({ garmentImage, designs, setDesigns, sideLabel, mode = "self", designLibrary = [], designFolders = [], productCategory = null }) {
  // Una carpeta puede quedar atada a una categoría de producto (ej: "Mates")
  // para que sus diseños solo aparezcan al personalizar esa categoría — las
  // carpetas sin categoría asignada ("Todas") se ven siempre, en cualquier
  // producto.
  const visibleFolders = designFolders.filter((f) => !f.category || f.category === productCategory);
  const containerRef = useRef(null);
  const zoomContainerRef = useRef(null);
  const draggingId = useRef(null);
  const resizingId = useRef(null);
  const rotatingId = useRef(null);
  const [selectedId, setSelectedId] = useState(null);
  const [showLibrary, setShowLibrary] = useState(false);
  // Si hay carpetas creadas, la librería se navega por carpeta en vez de
  // mostrar todos los diseños juntos en una sola grilla — null es la vista de
  // carpetas, "__sueltos__" son los diseños sin carpeta asignada.
  const [activeLibraryFolder, setActiveLibraryFolder] = useState(null);
  const [showZoom, setShowZoom] = useState(false);
  // Acercar de verdad en "Ver en grande": la tela crece más que el marco
  // visible y aparece scroll para recorrerla, en vez de solo verla más grande
  // sin poder acercarse a los detalles.
  const [zoom, setZoom] = useState(1);

  const addLayer = (image) => {
    const id = genId("dl");
    setDesigns((prev) => [...prev, { id, image, x: 50, y: 42, widthPct: 0.38, rotation: 0 }]);
    setSelectedId(id);
    setShowLibrary(false);
  };

  const handleUpload = async (file) => {
    if (!file) return;
    const isPng = file.type === "image/png";
    const b64 = await new Promise((resolve) => fileToBase64(file, resolve, 1200, isPng ? 1 : 0.9, isPng ? "image/png" : "image/jpeg"));
    addLayer(b64);
  };

  const removeLayer = (id) => {
    setDesigns((prev) => prev.filter((d) => d.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  };

  const onPointerDown = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    draggingId.current = id;
    setSelectedId(id);
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}
  };
  const onResizeStart = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    resizingId.current = id;
    setSelectedId(id);
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}
  };
  const onRotateStart = (e, id) => {
    e.preventDefault();
    e.stopPropagation();
    rotatingId.current = id;
    setSelectedId(id);
    try { e.target.setPointerCapture?.(e.pointerId); } catch {}
  };
  // "ref" es el contenedor que se está usando para calcular la posición
  // relativa (%) — el chico de siempre, o el grande de la vista ampliada —
  // así el arrastre/resize/rotación funcionan igual de bien en los dos.
  const onPointerMove = (e, ref = containerRef) => {
    if (!ref.current) return;
    if (draggingId.current) {
      const rect = ref.current.getBoundingClientRect();
      let x = ((e.clientX - rect.left) / rect.width) * 100;
      let y = ((e.clientY - rect.top) / rect.height) * 100;
      x = Math.max(0, Math.min(100, x));
      y = Math.max(0, Math.min(100, y));
      const id = draggingId.current;
      setDesigns((prev) => prev.map((d) => (d.id === id ? { ...d, x, y } : d)));
      return;
    }
    if (resizingId.current) {
      const rect = ref.current.getBoundingClientRect();
      const id = resizingId.current;
      setDesigns((prev) => prev.map((d) => {
        if (d.id !== id) return d;
        const cx = rect.left + (d.x / 100) * rect.width;
        const cy = rect.top + (d.y / 100) * rect.height;
        const dx = e.clientX - cx, dy = e.clientY - cy;
        // Deshacemos la rotación actual del diseño para medir el arrastre
        // como si estuviera derecho — así el tamaño responde igual sin
        // importar cuánto esté inclinado.
        const rad = (-(d.rotation || 0) * Math.PI) / 180;
        const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
        const widthPct = Math.max(0.05, Math.min(1.5, (localX * 2) / rect.width));
        return { ...d, widthPct };
      }));
      return;
    }
    if (rotatingId.current) {
      const rect = ref.current.getBoundingClientRect();
      const id = rotatingId.current;
      setDesigns((prev) => prev.map((d) => {
        if (d.id !== id) return d;
        const cx = rect.left + (d.x / 100) * rect.width;
        const cy = rect.top + (d.y / 100) * rect.height;
        const dx = e.clientX - cx, dy = e.clientY - cy;
        let rotation = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
        rotation = ((rotation + 180) % 360 + 360) % 360 - 180;
        return { ...d, rotation };
      }));
      return;
    }
  };
  const stopDrag = () => { draggingId.current = null; resizingId.current = null; rotatingId.current = null; };

  // Una capa de diseño con sus manijas de mover / agrandar / rotar — se
  // dibuja igual en la vista chica y en "Ver en grande" (misma lógica, sin
  // duplicar el cálculo de ángulos ni de tamaño).
  const renderLayer = (d) => (
    <div
      key={d.id}
      onPointerDown={(e) => onPointerDown(e, d.id)}
      className="absolute cursor-move"
      style={{
        width: `${d.widthPct * 100}%`,
        left: `${d.x}%`,
        top: `${d.y}%`,
        transform: `translate(-50%, -50%) rotate(${d.rotation || 0}deg)`,
        touchAction: "none",
      }}
    >
      <img
        src={d.image}
        alt="Diseño"
        draggable={false}
        className="w-full h-auto block pointer-events-none"
        style={{
          filter: "drop-shadow(0 6px 14px rgba(0,0,0,0.35))",
          outline: d.id === selectedId ? "2px dashed var(--sun)" : "none",
          outlineOffset: 3,
        }}
      />
      {d.id === selectedId && (
        <>
          <button
            type="button"
            onPointerDown={(e) => onRotateStart(e, d.id)}
            className="kulto-btn absolute rounded-full flex items-center justify-center"
            style={{
              top: -26, left: "50%", transform: "translateX(-50%)",
              width: 22, height: 22, background: "var(--sun)", color: "var(--ink)",
              border: "2px solid var(--ink)", touchAction: "none", cursor: "grab",
            }}
            title="Arrastrá para inclinar"
            aria-label="Rotar diseño"
          >
            <RotateCw size={12} />
          </button>
          <button
            type="button"
            onPointerDown={(e) => onResizeStart(e, d.id)}
            className="kulto-btn absolute rounded-full"
            style={{
              bottom: -8, right: -8, width: 18, height: 18,
              background: "var(--sun)", border: "2px solid var(--ink)",
              touchAction: "none", cursor: "nwse-resize",
            }}
            title="Arrastrá para agrandar o achicar"
            aria-label="Redimensionar diseño"
          />
        </>
      )}
    </div>
  );

  const selected = designs.find((d) => d.id === selectedId) || null;

  if (!garmentImage) {
    return (
      <p className="text-sm text-center" style={{ color: "var(--signal)" }}>
        Todavía no hay foto de {sideLabel} cargada para esta prenda en este color. Escribinos por WhatsApp y lo coordinamos.
      </p>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="relative rounded-2xl overflow-hidden mx-auto select-none"
        style={{ background: "var(--ink-3)", border: "1px solid var(--line)", aspectRatio: "4 / 5", maxWidth: 380, touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerUp={stopDrag}
        onPointerLeave={stopDrag}
        onPointerCancel={stopDrag}
      >
        <img loading="lazy" src={garmentImage} className="absolute inset-0 w-full h-full object-contain pointer-events-none" alt="" />
        {designs.map(renderLayer)}
        <button
          type="button"
          onClick={() => { setZoom(1); setShowZoom(true); }}
          className="kulto-btn absolute top-2 right-2 rounded-full p-2"
          style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.3)", color: "#fff" }}
          title="Ver en grande y acercarme"
        >
          <ZoomIn size={16} />
        </button>
      </div>

      {designs.length > 0 && (
        <p className="text-xs text-center mt-2" style={{ color: "var(--slate)" }}>
          Tocá una imagen para seleccionarla. Arrastrala para moverla, la manija de arriba para inclinarla y la de la esquina para agrandarla o achicarla.
        </p>
      )}

      {showZoom && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4 overflow-y-auto"
          style={{ background: "rgba(0,0,0,0.85)", zIndex: 200 }}
          onClick={() => setShowZoom(false)}
        >
          <div className="relative w-full max-w-2xl my-auto" onClick={(e) => e.stopPropagation()}>
            <div
              className="rounded-2xl overflow-auto mx-auto"
              style={{ background: "var(--ink-3)", maxHeight: "80vh" }}
            >
              <div
                ref={zoomContainerRef}
                className="relative select-none"
                style={{ width: `${zoom * 100}%`, aspectRatio: "4 / 5", touchAction: "none" }}
                onPointerMove={(e) => onPointerMove(e, zoomContainerRef)}
                onPointerUp={stopDrag}
                onPointerLeave={stopDrag}
                onPointerCancel={stopDrag}
              >
                <img loading="lazy" src={garmentImage} className="absolute inset-0 w-full h-full object-contain pointer-events-none" alt="" />
                {designs.map(renderLayer)}
              </div>
            </div>
            <div className="flex items-center justify-center gap-3 mt-3">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(1, Math.round((z - 0.5) * 100) / 100))}
                className="kulto-btn rounded-full p-2"
                style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "#fff" }}
                title="Alejar"
                aria-label="Alejar"
              >
                <ZoomOut size={16} />
              </button>
              <span className="text-xs font-semibold" style={{ color: "#fff", minWidth: 44, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.5) * 100) / 100))}
                className="kulto-btn rounded-full p-2"
                style={{ background: "var(--ink-2)", border: "1px solid var(--line)", color: "#fff" }}
                title="Acercar"
                aria-label="Acercar"
              >
                <ZoomIn size={16} />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setShowZoom(false)}
              className="kulto-btn absolute -top-3 -right-3 rounded-full p-2"
              style={{ background: "var(--ink)", border: "1px solid var(--line)", color: "#fff" }}
              title="Cerrar"
              aria-label="Cerrar vista ampliada"
            >
              <X size={18} />
            </button>
            <p className="text-xs text-center mt-3" style={{ color: "#fff" }}>
              {zoom > 1 ? "Recorré la tela con scroll — arrastrá el diseño para ubicarlo." : designs.length > 0 ? "Usá +/- para acercarte, o arrastrá el diseño para ubicarlo." : "Tocá afuera para cerrar"}
            </p>
          </div>
        </div>
      )}

      {selected && (
        <div className="mt-2 flex flex-col gap-2 max-w-[380px] mx-auto rounded-xl p-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <label className="text-xs flex items-center gap-2" style={{ color: "var(--slate)" }}>
            Tamaño de la imagen seleccionada
            <input
              type="range" min="0.05" max="1.5" step="0.01"
              value={selected.widthPct}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setDesigns((prev) => prev.map((d) => (d.id === selected.id ? { ...d, widthPct: val } : d)));
              }}
              className="flex-1"
            />
          </label>
          <label className="text-xs flex items-center gap-2" style={{ color: "var(--slate)" }}>
            Inclinación
            <input
              type="range" min="-180" max="180" step="1"
              value={selected.rotation || 0}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setDesigns((prev) => prev.map((d) => (d.id === selected.id ? { ...d, rotation: val } : d)));
              }}
              className="flex-1"
            />
          </label>
          <div className="flex items-center justify-center gap-2">
            {(selected.rotation || 0) !== 0 && (
              <button
                type="button"
                onClick={() => setDesigns((prev) => prev.map((d) => (d.id === selected.id ? { ...d, rotation: 0 } : d)))}
                className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full"
                style={{ border: "1px solid var(--line)", color: "var(--slate)" }}
              >
                Enderezar
              </button>
            )}
            <button type="button" onClick={() => removeLayer(selected.id)} className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full" style={{ border: "1px solid var(--line)", color: "var(--signal)" }}>
              Quitar esta imagen
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-col items-center gap-2 max-w-[460px] mx-auto">
        {mode === "library" ? (
          showLibrary ? (
            <div className="w-full">
              {visibleFolders.length > 0 && activeLibraryFolder === null ? (
                <>
                  <p className="text-xs text-center mb-2" style={{ color: "var(--slate)" }}>Elegí una carpeta</p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {visibleFolders.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setActiveLibraryFolder(f.id)}
                        className="kulto-btn flex flex-col items-center gap-1 rounded-xl p-2"
                        style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}
                      >
                        <FolderCoverThumb coverDesignIds={f.coverDesignIds || []} allDesigns={designLibrary} size={56} />
                        <span className="text-[11px] font-semibold max-w-[70px] truncate" style={{ color: "var(--bone)" }}>{f.name}</span>
                      </button>
                    ))}
                    {designLibrary.some((d) => !d.folderId) && (
                      <button
                        type="button"
                        onClick={() => setActiveLibraryFolder("__sueltos__")}
                        className="kulto-btn flex flex-col items-center gap-1 rounded-xl p-2"
                        style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}
                      >
                        <div className="rounded-lg flex items-center justify-center" style={{ width: 56, height: 56, background: "var(--ink)" }}>
                          <Package size={20} color="rgba(243,239,230,0.4)" />
                        </div>
                        <span className="text-[11px] font-semibold" style={{ color: "var(--bone)" }}>Otros</span>
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  {visibleFolders.length > 0 && (
                    <button type="button" onClick={() => setActiveLibraryFolder(null)} className="kulto-btn text-xs font-semibold flex items-center gap-1 mb-2" style={{ color: "var(--slate)" }}>
                      <ArrowLeft size={12} /> Carpetas
                    </button>
                  )}
                  <p className="text-xs text-center mb-2" style={{ color: "var(--slate)" }}>Elegí uno de nuestros diseños</p>
                  {(() => {
                    // Si no hay ninguna carpeta en todo el sistema, se ve todo
                    // suelto como antes. Si hay carpetas pero ninguna aplica a
                    // esta categoría, no mostramos los diseños de carpetas de
                    // otras categorías — solo los sueltos (sin carpeta).
                    const list =
                      designFolders.length === 0
                        ? designLibrary
                        : visibleFolders.length === 0
                          ? designLibrary.filter((d) => !d.folderId)
                          : activeLibraryFolder === "__sueltos__"
                            ? designLibrary.filter((d) => !d.folderId)
                            : designLibrary.filter((d) => d.folderId === activeLibraryFolder);
                    return list.length ? (
                      // Grilla de 3 en vez de 4 por fila (más grande cada una) —
                      // para que el cliente se dé una idea real del diseño de
                      // un vistazo, sin tener que clickearlo para verlo recién
                      // sobre la prenda.
                      <div className="grid grid-cols-3 gap-2">
                        {list.map((d) => (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => addLayer(d.image)}
                            className="kulto-btn rounded-lg overflow-hidden aspect-square"
                            style={{ background: "#fff", border: "1px solid var(--line)" }}
                            title={d.name}
                          >
                            <img loading="lazy" src={d.image} className="w-full h-full object-contain p-1" alt={d.name} />
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-center" style={{ color: "var(--signal)" }}>Todavía no hay diseños acá.</p>
                    );
                  })()}
                </>
              )}
              <button type="button" onClick={() => { setShowLibrary(false); setActiveLibraryFolder(null); }} className="kulto-btn text-xs mt-2 mx-auto block" style={{ color: "var(--slate)" }}>
                Cancelar
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowLibrary(true)}
              className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-2"
              style={{ background: "var(--signal)", color: "var(--bone)" }}
            >
              <Plus size={16} /> {designs.length ? "Agregar otro diseño" : "Elegir un diseño"}
            </button>
          )
        ) : (
          <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            <Upload size={16} /> {designs.length ? "Agregar otra imagen" : "Subir imagen"}
            <input type="file" accept="image/png, image/jpeg" className="hidden" onChange={(e) => handleUpload(e.target.files?.[0])} />
          </label>
        )}
      </div>
    </div>
  );
}

// Tarjeta de selección de prenda en el paso 1 de "Personalizar": al pasar el
// mouse (o tocar el ícono "i" en el celular, donde no existe el hover) se da
// vuelta y muestra una descripción libre (de qué está hecha, etc.) más los
// colores disponibles como bolitas de color — con un "+N" si hay más de los
// que entran, para avisar que hay más opciones sin ocupar toda la tarjeta.
const TEMPLATE_CARD_MAX_DOTS = 8;

function TemplateProductCard({ product, onSelect }) {
  const [flipped, setFlipped] = useState(false);
  const thumb = product.colors?.[0]?.frontImage || product.colors?.[0]?.images?.[0] || product.photoPool?.[0];
  const colors = product.colors || [];
  const shownColors = colors.slice(0, TEMPLATE_CARD_MAX_DOTS);
  const extraColors = colors.length - shownColors.length;
  const hasBackInfo = !!(product.description?.trim() || colors.length > 0);

  return (
    <div className="kulto-flip-outer" style={{ aspectRatio: "4 / 5.6" }}>
      <div className={`kulto-flip-inner ${flipped ? "is-flipped" : ""}`}>
        <button
          onClick={() => onSelect(product)}
          className="kulto-btn kulto-flip-face relative rounded-2xl overflow-hidden flex flex-col items-center text-center"
          style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
        >
          <div className="w-full flex-1 overflow-hidden flex items-center justify-center" style={{ background: product.colors?.[0]?.hex || "var(--ink-3)" }}>
            {thumb ? <img loading="lazy" src={thumb} className="w-full h-full object-contain" alt={product.name} /> : <Shirt size={32} style={{ color: "rgba(243,239,230,0.4)" }} />}
          </div>
          {product.audience && product.audience !== "unisex" && (
            <span
              className="absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10px] font-semibold"
              style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
            >
              {AUDIENCE_LABELS[product.audience] || product.audience}
            </span>
          )}
          <span
            className="font-semibold text-sm py-2 px-2"
            style={{ color: "var(--bone)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2.6em" }}
          >
            {product.name}
          </span>
          {hasBackInfo && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Ver detalles de la prenda"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFlipped(true); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setFlipped(true); } }}
              className="kulto-btn absolute top-2 right-2 rounded-full p-1.5 flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
            >
              <Info size={14} />
            </span>
          )}
        </button>

        {hasBackInfo && (
          <div
            className="kulto-flip-face kulto-flip-back relative rounded-2xl overflow-hidden flex flex-col p-3 gap-2 text-left"
            style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
          >
            <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>{product.name}</p>
            <p className="text-xs flex-1 overflow-y-auto kulto-scrollbar" style={{ color: "var(--slate)" }}>
              {product.description?.trim() || "Elegí esta prenda para personalizarla."}
            </p>
            {colors.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {shownColors.map((c, i) => (
                  <span key={i} className="w-4 h-4 rounded-full shrink-0" style={{ background: c.hex, border: "1px solid rgba(255,255,255,0.4)" }} title={c.name} />
                ))}
                {extraColors > 0 && <span className="text-[11px] font-semibold" style={{ color: "var(--sun)" }}>+{extraColors}</span>}
              </div>
            )}
            <button
              onClick={() => onSelect(product)}
              className="kulto-btn text-xs font-semibold rounded-full py-2 mt-1"
              style={{ background: "var(--signal)", color: "var(--bone)" }}
            >
              Elegir esta prenda
            </button>
            <span
              role="button"
              tabIndex={0}
              aria-label="Volver"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setFlipped(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); setFlipped(false); } }}
              className="kulto-btn absolute top-2 right-2 rounded-full p-1.5 flex items-center justify-center"
              style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
            >
              <X size={14} />
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Wizard({ products, categories, settings, designLibrary, designFolders, onAddToCart, onOpenProduct, favorites, onToggleFavorite, onGoHome }) {
  const [step, setStep] = useState(1); // 1 prenda, 2 color, 3 talla, 4 diseño (fuente/adelante/atrás/vista final)
  const [prod, setProd] = useState(null);
  const [colorIdx, setColorIdx] = useState(0);
  const [sizeIdx, setSizeIdx] = useState(0);
  // "source": null (eligiendo) | "self" (sube su foto) | "library" (elige un diseño de Kulto) | "service" (pide que se lo hagamos)
  const [source, setSource] = useState(null);
  const [consent, setConsent] = useState(false);
  const [side, setSide] = useState("front"); // clave de zona actual ("front", "back", "sleeveLeft", "sleeveRight") o "preview"
  const [frontDesigns, setFrontDesigns] = useState([]); // array de imágenes ajustables, no un límite de una sola
  const [backDesigns, setBackDesigns] = useState([]);
  const [sleeveLeftDesigns, setSleeveLeftDesigns] = useState([]);
  const [sleeveRightDesigns, setSleeveRightDesigns] = useState([]);
  const [composing, setComposing] = useState(false);
  const [composed, setComposed] = useState({ front: null, back: null, sleeveLeft: null, sleeveRight: null });
  const [qty, setQty] = useState(1);
  const [justAdded, setJustAdded] = useState(false);
  // Qué foto de la vista final se está mostrando (adelante/atrás/mangas, todas
  // en una sola tarjeta que se navega con flechitas en vez de 4 cuadros sueltos).
  const [previewIdx, setPreviewIdx] = useState(0);
  useEffect(() => { setPreviewIdx(0); }, [side]);
  // Hover zoom + vista ampliada en la foto final, igual que en la ficha de un
  // producto normal — antes esta pantalla no tenía ninguna de las dos.
  const [previewHoverZoom, setPreviewHoverZoom] = useState(false);
  const [previewZoomOrigin, setPreviewZoomOrigin] = useState({ x: 50, y: 50 });
  const [previewZoomOpen, setPreviewZoomOpen] = useState(false);

  // Solo las prendas marcadas por el administrador como "base para sublimar"
  // (tags.template) aparecen acá — nunca se mezclan con el catálogo de venta normal.
  const [groupSel, setGroupSel] = useState(null);
  const [subgroupSel, setSubgroupSel] = useState(null);
  // Filtro opcional por "para quién" (Hombre/Mujer/Niños/Unisex) dentro del
  // paso de elegir modelo — solo se muestra si hay más de un valor entre los
  // modelos de ese grupo/subgrupo, para no agregar ruido cuando no hace falta.
  const [audienceFilter, setAudienceFilter] = useState("todos");

  const productsWithColors = products.filter((p) => p.tags?.template && !p.hidden && p.colors && p.colors.length > 0);
  // Grupo → Subgrupo → Modelo: el grupo es la categoría (ej: "Camisetas"), el
  // subgrupo es el estilo dentro de esa categoría (ej: "Oversize") y el modelo
  // es la prenda final con sus fotos y colores (ej: "Beagle").
  const templateGroups = Array.from(new Set(productsWithColors.map((p) => p.category).filter(Boolean)));
  const productsInGroup = groupSel ? productsWithColors.filter((p) => p.category === groupSel) : [];
  const subgroupsInGroup = Array.from(new Set(productsInGroup.map((p) => p.subcategory).filter(Boolean)));
  const hasUngroupedInGroup = productsInGroup.some((p) => !p.subcategory);
  const needsSubgroupStep = subgroupsInGroup.length > 0;
  const modelsToShow = !groupSel
    ? []
    : !needsSubgroupStep
    ? productsInGroup
    : subgroupSel === "__sin_subgrupo__"
    ? productsInGroup.filter((p) => !p.subcategory)
    : subgroupSel
    ? productsInGroup.filter((p) => p.subcategory === subgroupSel)
    : [];
  // El filtro por "para quién" solo se ofrece si hay más de un valor entre
  // los modelos que ya se van a mostrar — unisex cuenta como "le sirve a
  // cualquiera", así que también aparece al filtrar por Hombre/Mujer/Niños.
  const audienceValuesShown = Array.from(new Set(modelsToShow.map((p) => p.audience || "unisex")));
  const showAudienceFilter = audienceValuesShown.length > 1;
  const modelsFiltered = !showAudienceFilter || audienceFilter === "todos"
    ? modelsToShow
    : modelsToShow.filter((p) => {
        const a = p.audience || "unisex";
        return audienceFilter === "unisex" ? a === "unisex" : (a === audienceFilter || a === "unisex");
      });
  const pickStage = !groupSel ? "group" : needsSubgroupStep && !subgroupSel ? "subgroup" : "model";
  const selectGroup = (g) => { setGroupSel(g); setSubgroupSel(null); setAudienceFilter("todos"); };
  // Si el estilo elegido tiene un solo modelo cargado, ese modelo ya está
  // implícito en la elección — pasamos directo a color/talla en vez de
  // mostrar un paso "Elegí el modelo" que repetiría lo mismo que se acaba
  // de elegir con una sola opción para tocar.
  const selectSubgroup = (sg) => {
    setSubgroupSel(sg);
    setAudienceFilter("todos");
    const matches = sg === "__sin_subgrupo__"
      ? productsInGroup.filter((p) => !p.subcategory)
      : productsInGroup.filter((p) => p.subcategory === sg);
    if (matches.length === 1) resetForProduct(matches[0]);
  };
  const backToGroups = () => { setGroupSel(null); setSubgroupSel(null); setAudienceFilter("todos"); };
  const backToSubgroups = () => { setSubgroupSel(null); setAudienceFilter("todos"); };

  const color = prod && prod.colors ? prod.colors[colorIdx] : null;
  const colorsForProduct = prod ? prod.colors || [] : [];
  const hasSizes = prod && prod.sizes && prod.sizes.length > 0;
  const size = hasSizes ? prod.sizes[sizeIdx] : null;
  // Prioridad del precio en Personalizar: (1) precio propio de la prenda
  // base, si el admin le puso uno puntual; (2) el precio que el admin le
  // haya puesto a esa subcategoría/estilo (Beagle, Oversize, etc.) en
  // "Precios por estilo"; (3) el precio general de Personalizar, como
  // último respaldo si no se configuró nada más específico.
  const subcategoryPrice = prod?.subcategory ? settings.personalizeSubcategoryPrices?.[prod.subcategory] : null;
  const unitPrice = prod
    ? (prod.price != null
        ? Number(prod.price)
        : (subcategoryPrice != null ? Number(subcategoryPrice) : Number(settings.personalizedBasePrice) || 0))
    : 0;

  // Al terminar de personalizar, sugerimos productos reales del catálogo
  // (no otras prendas base) para que se sumen al carrito — priorizando la
  // misma categoría de lo que acaba de personalizar.
  const sellableForRecs = products.filter((p) => !p.tags?.template);
  const recommendedProducts = prod
    ? (() => {
        const sameCategory = sellableForRecs.filter((p) => p.category === prod.category);
        const rest = sellableForRecs.filter((p) => p.category !== prod.category);
        return [...sameCategory, ...rest].slice(0, 4);
      })()
    : [];

  // Adelante siempre es el primer paso (incluso sin foto configurada, para avisarlo);
  // atrás y mangas solo aparecen como pasos si el admin cargó esa foto para el color.
  const zoneConfig = {
    front: { image: color?.frontImage, designs: frontDesigns, setDesigns: setFrontDesigns, label: "ADELANTE", sideLabel: "adelante" },
    back: { image: color?.backImage, designs: backDesigns, setDesigns: setBackDesigns, label: "ATRÁS", sideLabel: "atrás" },
    sleeveLeft: { image: color?.sleeveLeftImage, designs: sleeveLeftDesigns, setDesigns: setSleeveLeftDesigns, label: "MANGA IZQ.", sideLabel: "manga izquierda" },
    sleeveRight: { image: color?.sleeveRightImage, designs: sleeveRightDesigns, setDesigns: setSleeveRightDesigns, label: "MANGA DER.", sideLabel: "manga derecha" },
  };
  const availableZones = ["front", "back", "sleeveLeft", "sleeveRight"].filter((z) => zoneConfig[z].image);
  // La primera zona con foto cargada — ya no asumimos que siempre es "adelante",
  // porque el admin puede haber cargado, por ejemplo, solo la foto de atrás.
  const activeZone = availableZones.includes(side) ? side : availableZones[0];

  const steps = [
    { n: 1, label: "Prenda" },
    { n: 2, label: "Color" },
    { n: 3, label: "Talla" },
    { n: 4, label: "Diseño" },
  ];

  const resetDesignState = () => {
    setSource(null);
    setConsent(false);
    setSide("front");
    setFrontDesigns([]);
    setBackDesigns([]);
    setSleeveLeftDesigns([]);
    setSleeveRightDesigns([]);
    setComposed({ front: null, back: null, sleeveLeft: null, sleeveRight: null });
  };

  const resetForProduct = (p) => {
    setProd(p);
    setColorIdx(0);
    setSizeIdx(0);
    resetDesignState();
    setQty(1);
    setStep(p.colors && p.colors.length > 0 ? 2 : 3);
  };

  const goToStep4 = () => {
    resetDesignState();
    setStep(4);
  };

  const finishSide = async (currentZone) => {
    const idx = availableZones.indexOf(currentZone);
    const next = availableZones[idx + 1];
    if (next) {
      setSide(next);
    } else {
      setSide("preview");
      await renderPreview();
    }
  };

  const renderPreview = async () => {
    setComposing(true);
    const [front, back, sleeveLeft, sleeveRight] = await Promise.all([
      composeDesignImage(color?.frontImage, null, frontDesigns),
      composeDesignImage(color?.backImage, null, backDesigns),
      composeDesignImage(color?.sleeveLeftImage, null, sleeveLeftDesigns),
      composeDesignImage(color?.sleeveRightImage, null, sleeveRightDesigns),
    ]);
    setComposed({ front, back, sleeveLeft, sleeveRight });
    setComposing(false);
  };

  const confirmServiceRequest = async () => {
    setSide("preview");
    await renderPreview();
  };

  const designServiceFee = source === "service" ? Number(settings?.designServiceFee) || 0 : 0;
  const anyDesignsPlaced = frontDesigns.length || backDesigns.length || sleeveLeftDesigns.length || sleeveRightDesigns.length;

  const handleAdd = () => {
    const item = {
      cartId: genId("c"),
      productId: prod.id,
      sku: prod.sku || prod.id,
      name: prod.name,
      category: prod.category,
      colorName: color ? color.name : "Único",
      colorHex: color ? color.hex : "#999",
      size,
      designName:
        source === "service"
          ? "Personalizado (diseño a cargo de Kulto — a coordinar por WhatsApp)"
          : `Personalizado${anyDesignsPlaced ? "" : " (sin imagen — a coordinar por WhatsApp)"}`,
      previewImage: composed.front || composed.back || composed.sleeveLeft || composed.sleeveRight || color?.frontImage || null,
      previewImageFront: composed.front || null,
      previewImageBack: composed.back || null,
      previewImageSleeveLeft: composed.sleeveLeft || null,
      previewImageSleeveRight: composed.sleeveRight || null,
      qty,
      unitPrice: unitPrice + designServiceFee,
      points: prod.points ?? null,
    };
    onAddToCart(item);
    setJustAdded(true);
    // Dejamos ver el "¡Agregado!" un momento y despues volvemos al inicio —
    // antes se quedaba trabado en esta pantalla sin avisar que ya terminó.
    setTimeout(() => {
      setJustAdded(false);
      onGoHome?.();
    }, 1400);
  };

  return (
    <div className="max-w-4xl mx-auto px-4 md:px-6 py-10">
      <SectionTitle eyebrow="Hazlo tuyo" title="Personaliza tu prenda" />

      <div className="flex items-center gap-2 md:gap-3 mb-8 flex-wrap">
        {steps.map((s, i) => (
          <div key={s.n} className="flex items-center gap-2 md:gap-3">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
              style={{ background: step >= s.n ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
            >
              {s.n}
            </div>
            <span className="text-sm" style={{ color: step >= s.n ? "var(--bone)" : "var(--slate)" }}>{s.label}</span>
            {i < steps.length - 1 && <div className="w-6 md:w-8 h-px" style={{ background: "var(--line)" }} />}
          </div>
        ))}
      </div>

      {/* Paso 1: elegí grupo → subgrupo (si aplica) → modelo, estilo "elegí tu personaje" */}
      {step === 1 && (
        <div>
          {pickStage === "group" && (
            <div>
              <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>1. Elegí qué querés personalizar</p>
              {templateGroups.length ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {templateGroups.map((g) => {
                    const sample = productsWithColors.find((p) => p.category === g);
                    const thumb = settings.personalizeGroupCovers?.[g] || sample?.colors?.[0]?.frontImage || sample?.colors?.[0]?.images?.[0];
                    return (
                      <button
                        key={g}
                        onClick={() => selectGroup(g)}
                        className="kulto-btn rounded-2xl overflow-hidden text-left flex flex-col"
                        style={{ background: "var(--ink-2)", border: "1px solid var(--line)", aspectRatio: "4 / 5" }}
                      >
                        <div className="w-full flex-1 overflow-hidden flex items-center justify-center" style={{ background: sample?.colors?.[0]?.hex || "var(--ink-3)" }}>
                          {thumb ? <img loading="lazy" src={thumb} className="w-full h-full object-contain p-3" alt={g} /> : <Shirt size={32} style={{ color: "rgba(243,239,230,0.4)" }} />}
                        </div>
                        <div className="p-3">
                          <p
                            className="text-sm font-semibold"
                            style={{ color: "var(--bone)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2.6em" }}
                          >
                            {g}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <EmptyState text="Todavía no hay prendas cargadas para personalizar." />
              )}
            </div>
          )}

          {pickStage === "subgroup" && (
            <div>
              <button onClick={backToGroups} className="kulto-btn text-sm flex items-center gap-1 mb-5" style={{ color: "var(--slate)" }}>
                <ChevronLeft size={16} /> Elegir otro grupo
              </button>
              <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>1. Elegí el estilo de {groupSel}</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                {subgroupsInGroup.map((sg) => {
                  const sample = productsInGroup.find((p) => p.subcategory === sg);
                  const thumb = sample?.colors?.[0]?.frontImage || sample?.colors?.[0]?.images?.[0];
                  return (
                    <button
                      key={sg}
                      onClick={() => selectSubgroup(sg)}
                      className="kulto-btn rounded-2xl overflow-hidden text-left flex flex-col"
                      style={{ background: "var(--ink-2)", border: "1px solid var(--line)", aspectRatio: "4 / 5" }}
                    >
                      <div className="w-full flex-1 overflow-hidden flex items-center justify-center" style={{ background: sample?.colors?.[0]?.hex || "var(--ink-3)" }}>
                        {thumb ? <img loading="lazy" src={thumb} className="w-full h-full object-contain p-3" alt={sg} /> : <Shirt size={32} style={{ color: "rgba(243,239,230,0.4)" }} />}
                      </div>
                      <div className="p-3">
                        <p
                          className="text-sm font-semibold"
                          style={{ color: "var(--bone)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2.6em" }}
                        >
                          {sg}
                        </p>
                      </div>
                    </button>
                  );
                })}
                {hasUngroupedInGroup && (
                  <button
                    onClick={() => selectSubgroup("__sin_subgrupo__")}
                    className="kulto-btn rounded-2xl overflow-hidden text-left flex flex-col"
                    style={{ background: "var(--ink-2)", border: "1px solid var(--line)", aspectRatio: "4 / 5" }}
                  >
                    <div className="w-full flex-1 overflow-hidden flex items-center justify-center" style={{ background: "var(--ink-3)" }}>
                      <Shirt size={32} style={{ color: "rgba(243,239,230,0.4)" }} />
                    </div>
                    <div className="p-3">
                      <p
                        className="text-sm font-semibold"
                        style={{ color: "var(--bone)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: "2.6em" }}
                      >
                        Otros
                      </p>
                    </div>
                  </button>
                )}
              </div>
            </div>
          )}

          {pickStage === "model" && (
            <div>
              <button
                onClick={() => (needsSubgroupStep ? backToSubgroups() : backToGroups())}
                className="kulto-btn text-sm flex items-center gap-1 mb-5"
                style={{ color: "var(--slate)" }}
              >
                <ChevronLeft size={16} /> {needsSubgroupStep ? "Elegir otro estilo" : "Elegir otro grupo"}
              </button>
              <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>1. Elegí el modelo</p>
              {showAudienceFilter && (
                <div className="flex flex-wrap gap-2 mb-4">
                  {["todos", ...AUDIENCE_OPTIONS].map((a) => (
                    <button
                      key={a}
                      onClick={() => setAudienceFilter(a)}
                      className="kulto-btn text-xs font-semibold rounded-full px-3 py-1.5"
                      style={{
                        background: audienceFilter === a ? "var(--signal)" : "var(--ink-3)",
                        color: audienceFilter === a ? "var(--bone)" : "var(--slate)",
                      }}
                    >
                      {a === "todos" ? "Todos" : AUDIENCE_LABELS[a]}
                    </button>
                  ))}
                </div>
              )}
              {modelsFiltered.length ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {modelsFiltered.map((p) => (
                    <TemplateProductCard key={p.id} product={p} onSelect={resetForProduct} />
                  ))}
                </div>
              ) : (
                <EmptyState text="Todavía no hay modelos cargados acá." />
              )}
            </div>
          )}
        </div>
      )}

      {/* Paso 2: color */}
      {step === 2 && prod && (
        <div>
          <button onClick={() => setStep(1)} className="kulto-btn text-sm flex items-center gap-1 mb-5" style={{ color: "var(--slate)" }}>
            <ChevronLeft size={16} /> Elegir otra prenda
          </button>
          <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>2. Elegí el color de {prod.name}</p>
          <div className="flex flex-wrap gap-3">
            {colorsForProduct.map((c, i) => (
              <button
                key={i}
                onClick={() => { setColorIdx(i); if (hasSizes) { setStep(3); } else { resetDesignState(); setStep(4); } }}
                className="kulto-btn flex flex-col items-center gap-2"
              >
                <span
                  className="w-14 h-14 rounded-full flex items-center justify-center"
                  style={{ background: c.hex, border: colorIdx === i ? "3px solid var(--sun)" : "1px solid var(--line)" }}
                >
                  {(c.frontImage || c.images?.[0]) && <img loading="lazy" src={c.frontImage || c.images[0]} className="w-10 h-10 object-contain rounded-full" alt="" />}
                </span>
                <span className="text-xs" style={{ color: "var(--bone)" }}>{c.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Paso 3: talla */}
      {step === 3 && prod && (
        <div>
          <button onClick={() => setStep(2)} className="kulto-btn text-sm flex items-center gap-1 mb-5" style={{ color: "var(--slate)" }}>
            <ChevronLeft size={16} /> Elegir otro color
          </button>
          <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>3. Elegí el talle</p>
          {hasSizes ? (
            <div className="flex flex-wrap gap-2">
              {prod.sizes.map((s, i) => (
                <button
                  key={s}
                  onClick={() => { setSizeIdx(i); goToStep4(); }}
                  className="kulto-btn text-sm font-semibold rounded-full px-5 py-2.5"
                  style={{ background: sizeIdx === i ? "var(--sun)" : "var(--ink-2)", color: sizeIdx === i ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)" }}
                >
                  {s}
                </button>
              ))}
            </div>
          ) : (
            <EmptyState text="Esta prenda no tiene talles configurados." />
          )}
          <SizeGuideToggle sizeGuide={prod.sizeGuide} sizeGuideImage={prod.sizeGuideImage} />
        </div>
      )}

      {/* Paso 4: fuente del diseño / adelante / atrás / vista final */}
      {step === 4 && prod && color && (
        <div>
          <button
            onClick={() => {
              if (source === null) { setStep(hasSizes ? 3 : 2); return; }
              if (source === "service") { setSource(null); setConsent(false); return; }
              if (side === "preview") { setSide(availableZones[availableZones.length - 1]); return; }
              const idx = availableZones.indexOf(activeZone);
              if (idx > 0) { setSide(availableZones[idx - 1]); return; }
              setSource(null);
            }}
            className="kulto-btn text-sm flex items-center gap-1 mb-5"
            style={{ color: "var(--slate)" }}
          >
            <ChevronLeft size={16} /> Volver
          </button>

          {source === null && (
            <div className="max-w-md mx-auto text-center">
              <p className="text-sm mb-5" style={{ color: "var(--slate)" }}>4. ¿Cómo querés tu diseño?</p>
              <div className="flex flex-col gap-3">
                <button
                  onClick={() => setSource("self")}
                  className="kulto-btn rounded-2xl p-4 text-left"
                  style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
                >
                  <span className="font-semibold text-sm block" style={{ color: "var(--bone)" }}>Subir mi propia imagen</span>
                  <span className="text-xs" style={{ color: "var(--slate)" }}>La subís vos y la ubicás como quieras.</span>
                </button>
                {designLibrary && designLibrary.length > 0 && (
                  <button
                    onClick={() => setSource("library")}
                    className="kulto-btn rounded-2xl p-4 text-left"
                    style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
                  >
                    <span className="font-semibold text-sm block" style={{ color: "var(--bone)" }}>Elegir un diseño de Kulto</span>
                    <span className="text-xs" style={{ color: "var(--slate)" }}>Usás uno de nuestros diseños y lo ubicás donde quieras.</span>
                  </button>
                )}
                {settings?.designServiceEnabled && (
                  <button
                    onClick={() => setSource("service")}
                    className="kulto-btn rounded-2xl p-4 text-left"
                    style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
                  >
                    <span className="font-semibold text-sm block" style={{ color: "var(--bone)" }}>
                      Que Kulto haga el diseño <span style={{ color: "var(--sun)" }}>(+{formatPrice(Number(settings.designServiceFee) || 0)})</span>
                    </span>
                    <span className="text-xs" style={{ color: "var(--slate)" }}>Lo coordinamos por WhatsApp antes de empezar.</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {source === "service" && (
            <div className="max-w-md mx-auto text-center">
              <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>4. Que Kulto haga tu diseño</p>
              <div className="rounded-2xl p-4 mb-4 text-left" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
                <p className="text-sm mb-2" style={{ color: "var(--bone)" }}>
                  Este servicio suma {formatPrice(designServiceFee)} al precio de la prenda.
                </p>
                <p className="text-xs" style={{ color: "var(--slate)" }}>
                  Antes de confirmar nada te escribimos por WhatsApp para saber exactamente qué buscás. Al ser un diseño hecho a medida, pedimos el {settings?.depositPercent || 50}% del pedido por adelantado para empezar a trabajar y evitar cancelaciones de último momento.
                </p>
              </div>
              <label className="flex items-start gap-2 text-xs text-left mb-4" style={{ color: "var(--bone)" }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
                Entiendo que me van a contactar por WhatsApp para coordinar el diseño y que se pide una seña del {settings?.depositPercent || 50}% del pedido antes de empezarlo.
              </label>
              <button
                disabled={!consent}
                onClick={confirmServiceRequest}
                className="kulto-btn text-sm font-semibold px-5 py-3 rounded-full w-full flex items-center justify-center gap-2"
                style={{ background: consent ? "var(--signal)" : "var(--ink-3)", color: consent ? "var(--bone)" : "var(--slate)", cursor: consent ? "pointer" : "default" }}
              >
                Solicitar diseño (+{formatPrice(designServiceFee)}) <ChevronRight size={16} />
              </button>
            </div>
          )}

          {(source === "self" || source === "library") && side !== "preview" && availableZones.length === 0 && (
            <div className="max-w-md mx-auto text-center">
              <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>
                Este color todavía no tiene fotos cargadas para personalizar. Elegí otro color, o escribinos por WhatsApp y lo coordinamos.
              </p>
              <button onClick={() => setStep(2)} className="kulto-btn text-sm font-semibold px-5 py-2.5 rounded-full" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                Elegir otro color
              </button>
            </div>
          )}

          {(source === "self" || source === "library") && side !== "preview" && zoneConfig[activeZone] && (
            <div>
              <p className="text-sm mb-1 text-center" style={{ color: "var(--slate)" }}>4. Diseño para {zoneConfig[activeZone].label} (opcional)</p>
              <PrintSizeGuide settings={settings} zone={activeZone} />
              <div className="mt-3">
                <DesignPlacer garmentImage={zoneConfig[activeZone].image} designs={zoneConfig[activeZone].designs} setDesigns={zoneConfig[activeZone].setDesigns} sideLabel={zoneConfig[activeZone].sideLabel} mode={source} designLibrary={designLibrary} designFolders={designFolders} productCategory={prod?.category || null} />
              </div>
              <div className="flex justify-center gap-3 mt-5">
                <button onClick={() => { zoneConfig[activeZone].setDesigns([]); finishSide(activeZone); }} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full" style={{ border: "1px solid var(--line)", color: "var(--slate)" }}>
                  Aquí no quiero nada
                </button>
                <button onClick={() => finishSide(activeZone)} className="kulto-btn text-sm font-semibold px-5 py-2.5 rounded-full flex items-center gap-1" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                  {availableZones.indexOf(activeZone) === availableZones.length - 1 ? "Ver mi prenda personalizada" : "Continuar"} <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}

          {side === "preview" && source && (
            <div>
              <p className="text-sm mb-4 text-center font-semibold" style={{ color: "var(--bone)" }}>Así quedaría tu prenda personalizada</p>
              {source === "service" && (
                <p className="text-xs text-center mb-4" style={{ color: "var(--slate)" }}>
                  El diseño lo vamos a coordinar por WhatsApp — esta es tu prenda tal como está, sin el diseño todavía.
                </p>
              )}
              {composing ? (
                <div className="flex items-center justify-center py-10">
                  <Loader2 size={28} className="animate-spin" style={{ color: "var(--sun)" }} />
                </div>
              ) : (
                <div className="max-w-[420px] mx-auto">
                  <div
                    className="relative rounded-2xl overflow-hidden"
                    style={{ border: "1px solid var(--line)", aspectRatio: "4 / 5", background: color.hex }}
                    onMouseEnter={() => { if (window.matchMedia?.("(hover: hover)").matches) setPreviewHoverZoom(true); }}
                    onMouseLeave={() => setPreviewHoverZoom(false)}
                    onMouseMove={(e) => {
                      if (!previewHoverZoom) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setPreviewZoomOrigin({ x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 });
                    }}
                  >
                    {composed[availableZones[previewIdx]] ? (
                      <img
                        loading="lazy"
                        src={composed[availableZones[previewIdx]]}
                        className="w-full h-full object-contain"
                        alt={zoneConfig[availableZones[previewIdx]]?.label}
                        style={{
                          transform: previewHoverZoom ? "scale(2.2)" : "scale(1)",
                          transformOrigin: `${previewZoomOrigin.x}% ${previewZoomOrigin.y}%`,
                          transition: previewHoverZoom ? "none" : "transform .25s ease",
                          cursor: previewHoverZoom ? "zoom-in" : "default",
                        }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center"><Shirt size={32} style={{ color: "rgba(243,239,230,0.4)" }} /></div>
                    )}
                    {composed[availableZones[previewIdx]] && (
                      <button
                        type="button"
                        onClick={() => setPreviewZoomOpen(true)}
                        className="kulto-btn absolute bottom-3 right-3 w-10 h-10 rounded-full flex items-center justify-center"
                        style={{ background: "rgba(21,19,26,0.75)", color: "var(--bone)" }}
                        title="Ver foto en grande"
                      >
                        <ZoomIn size={18} />
                      </button>
                    )}
                    {availableZones.length > 1 && (
                      <>
                        <button
                          onClick={() => setPreviewIdx((i) => (i - 1 + availableZones.length) % availableZones.length)}
                          className="kulto-btn absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center"
                          style={{ background: "rgba(21,19,26,0.55)", color: "var(--bone)" }}
                          aria-label="Foto anterior"
                        >
                          <ChevronLeft size={18} />
                        </button>
                        <button
                          onClick={() => setPreviewIdx((i) => (i + 1) % availableZones.length)}
                          className="kulto-btn absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full flex items-center justify-center"
                          style={{ background: "rgba(21,19,26,0.55)", color: "var(--bone)" }}
                          aria-label="Foto siguiente"
                        >
                          <ChevronRight size={18} />
                        </button>
                        <div className="absolute bottom-2 left-0 right-0 flex items-center justify-center gap-1">
                          {availableZones.map((z, i) => (
                            <button
                              key={z}
                              onClick={() => setPreviewIdx(i)}
                              className="kulto-btn rounded-full"
                              style={{ width: i === previewIdx ? 12 : 5, height: 5, background: i === previewIdx ? "var(--sun)" : "rgba(243,239,230,0.5)", transition: "width .15s" }}
                              aria-label={zoneConfig[z]?.label}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-center mt-2" style={{ color: "var(--slate)" }}>{zoneConfig[availableZones[previewIdx]]?.label}</p>
                </div>
              )}

              {previewZoomOpen && composed[availableZones[previewIdx]] && (
                <ImageLightbox
                  image={composed[availableZones[previewIdx]]}
                  background={color.hex}
                  onClose={() => setPreviewZoomOpen(false)}
                />
              )}

              <div className="max-w-[420px] mx-auto mt-6">
                <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>{prod.name}</p>
                <p className="text-xs mb-3" style={{ color: "var(--slate)" }}>
                  {color.name}{size ? ` · Talle ${size}` : ""} · {formatPrice(unitPrice + designServiceFee)}
                  {designServiceFee > 0 && <span> (incluye {formatPrice(designServiceFee)} de diseño)</span>}
                </p>
                <div className="flex items-center justify-between">
                  <div className="inline-flex items-center gap-3 rounded-full px-3 py-1.5" style={{ background: "var(--ink-3)" }}>
                    <button onClick={() => setQty((q) => Math.max(1, q - 1))} className="kulto-btn" style={{ color: "var(--bone)" }}><Minus size={14} /></button>
                    <span className="text-sm" style={{ color: "var(--bone)" }}>{qty}</span>
                    <button onClick={() => setQty((q) => q + 1)} className="kulto-btn" style={{ color: "var(--bone)" }}><Plus size={14} /></button>
                  </div>
                  <button
                    onClick={handleAdd}
                    className="kulto-btn text-sm font-semibold px-5 py-2.5 rounded-full flex items-center gap-2"
                    style={{ background: justAdded ? "var(--sun)" : "var(--signal)", color: justAdded ? "var(--ink)" : "var(--bone)" }}
                  >
                    {justAdded ? <><Check size={16} /> ¡Agregado!</> : "Agregar al carrito"}
                  </button>
                </div>
              </div>

              {recommendedProducts.length > 0 && (
                <div className="max-w-3xl mx-auto mt-10">
                  <p className="text-sm font-semibold mb-3" style={{ color: "var(--bone)" }}>También te puede interesar</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {recommendedProducts.map((p) => (
                      <ProductCard key={p.id} product={p} onOpen={onOpenProduct} isFavorite={favorites?.includes(p.id)} onToggleFavorite={onToggleFavorite} onAddToCart={onAddToCart} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Cart Drawer                                                        */
/* ------------------------------------------------------------------ */

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function CartDrawer({ cart, onClose, onUpdateQty, onRemove, onCheckout, customerName, setCustomerName, customerPhone, setCustomerPhone, customerEmail, setCustomerEmail, comment, setComment, deliveryMethod, setDeliveryMethod, address, setAddress, settings, sending, customer }) {
  const subtotal = cart.reduce((s, it) => s + it.qty * it.unitPrice, 0);
  const itemCount = cart.reduce((s, it) => s + it.qty, 0);
  // Suma el puntaje propio de cada prenda (si el admin le puso uno) y si no
  // usa el general de Ajustes → Fidelización, en vez de una cifra pareja por
  // ítem para todo el carrito.
  const pointsEarned = cart.reduce((s, it) => s + it.qty * (Number(it.points ?? settings.loyaltyPointsPerItem) || 0), 0);
  const [touched, setTouched] = useState(false);
  const emailOk = isValidEmail(customerEmail);
  const freeShipping = subtotal >= settings.freeShippingThreshold;
  // El costo de envío depende de a qué provincia/comunidad va el pedido —
  // cada una tiene su propio precio configurado en Ajustes → Envío (Canarias,
  // Ceuta y Melilla suelen salir más caras). Si todavía no eligió la
  // provincia, o no hay un precio cargado para esa provincia puntual, usamos
  // el costo de envío por defecto como respaldo.
  const shippingCostForRegion = (region) => {
    const byRegion = settings.shippingRegionPrices?.[region];
    return byRegion != null ? byRegion : settings.shippingFlatRate;
  };
  const shippingCost = deliveryMethod === "envio" ? (freeShipping ? 0 : shippingCostForRegion(address.state)) : 0;
  const eligibleForSignupDiscount = !!customer && !!settings?.signupDiscountEnabled && !customer.firstDiscountUsed;
  const discountAmount = eligibleForSignupDiscount ? subtotal * ((settings.signupDiscountPercent || 0) / 100) : 0;
  const total = subtotal - discountAmount + shippingCost;
  const addressOk = deliveryMethod !== "envio" || (address.street.trim() && address.city.trim() && address.state.trim() && address.postalCode.trim());
  const canCheckout = emailOk && addressOk;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" style={{ background: "rgba(0,0,0,0.6)" }} onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:w-[420px] h-full overflow-y-auto kulto-scrollbar p-5 flex flex-col"
        style={{ background: "var(--ink)", borderLeft: "1px solid var(--line)" }}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="kulto-display text-xl" style={{ color: "var(--bone)" }}>Tu carrito</h3>
          <button onClick={onClose} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--slate)" }} aria-label="Cerrar carrito"><X size={22} /></button>
        </div>

        {cart.length === 0 ? (
          <EmptyState text="Tu carrito está vacío. Explora el catálogo o personaliza una prenda." />
        ) : (
          <>
            <div className="flex flex-col gap-4 flex-1">
              {cart.map((it, idx) => (
                <div key={it.cartId} className="flex gap-3 rounded-2xl p-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
                  <div className="w-16 h-16 rounded-xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: it.colorHex }}>
                    {it.previewImage ? <img loading="lazy" src={it.previewImage} className="w-full h-full object-contain p-1" alt={it.name} /> : <Shirt size={22} color="rgba(243,239,230,0.5)" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs" style={{ color: "var(--slate)" }}>Ítem {idx + 1} · ref. {it.sku}</span>
                      <button onClick={() => onRemove(it.cartId)} className="kulto-btn" style={{ color: "var(--slate)" }}><Trash2 size={15} /></button>
                    </div>
                    <p className="font-semibold text-sm truncate" style={{ color: "var(--bone)" }}>{it.name}</p>
                    <p className="text-xs" style={{ color: "var(--slate)" }}>{it.colorName}{it.size ? ` · Talle ${it.size}` : ""}{it.designName ? ` · ${it.designName}` : ""}</p>
                    <div className="flex items-center justify-between mt-2">
                      <div className="inline-flex items-center gap-2 rounded-full px-2 py-0.5" style={{ background: "var(--ink-3)" }}>
                        <button onClick={() => onUpdateQty(it.cartId, Math.max(1, it.qty - 1))} className="kulto-btn" style={{ color: "var(--bone)" }}><Minus size={13} /></button>
                        <span className="text-sm" style={{ color: "var(--bone)" }}>{it.qty}</span>
                        <button onClick={() => onUpdateQty(it.cartId, it.qty + 1)} className="kulto-btn" style={{ color: "var(--bone)" }}><Plus size={13} /></button>
                      </div>
                      <span className="text-sm font-semibold" style={{ color: "var(--sun)" }}>{formatPrice(it.qty * it.unitPrice)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-5 flex flex-col gap-3">
              <input
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder="Tu nombre (opcional)"
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
              />
              <div>
                <input
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="Tu email — te avisamos si tu carrito queda pendiente"
                  className="w-full rounded-xl p-3 text-sm"
                  style={{ background: "var(--ink-2)", color: "var(--bone)", border: touched && !emailOk ? "1px solid var(--signal)" : "1px solid var(--line)" }}
                />
                {touched && !emailOk && (
                  <p className="text-xs mt-1" style={{ color: "var(--signal)" }}>Escribe un email válido para poder enviar tu pedido.</p>
                )}
              </div>
              <input
                value={customerPhone}
                onChange={(e) => setCustomerPhone(e.target.value)}
                placeholder="Tu teléfono (opcional)"
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
              />
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder="Comentario para tu pedido (opcional)"
                rows={2}
                className="w-full rounded-xl p-3 text-sm"
                style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
              />

              <div>
                <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>¿Cómo lo recibes?</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setDeliveryMethod("recogida")}
                    className="kulto-btn flex-1 text-xs font-semibold px-3 py-2 rounded-full"
                    style={{ background: deliveryMethod === "recogida" ? "var(--signal)" : "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  >
                    Recoger en persona
                  </button>
                  <button
                    onClick={() => setDeliveryMethod("envio")}
                    className="kulto-btn flex-1 text-xs font-semibold px-3 py-2 rounded-full"
                    style={{ background: deliveryMethod === "envio" ? "var(--signal)" : "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  >
                    Envío a domicilio
                  </button>
                </div>
              </div>

              {deliveryMethod === "envio" && (
                <div className="flex flex-col gap-2 rounded-xl p-3" style={{ background: "var(--ink-2)", border: touched && !addressOk ? "1px solid var(--signal)" : "1px solid var(--line)" }}>
                  <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Dirección de envío</p>
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      value={address.street}
                      onChange={(e) => setAddress({ ...address, street: e.target.value })}
                      onBlur={() => setTouched(true)}
                      placeholder="Calle"
                      className="col-span-2 rounded-lg p-2.5 text-sm"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                    <input
                      value={address.number}
                      onChange={(e) => setAddress({ ...address, number: e.target.value })}
                      placeholder="Número"
                      className="rounded-lg p-2.5 text-sm"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                  </div>
                  <input
                    value={address.apartment}
                    onChange={(e) => setAddress({ ...address, apartment: e.target.value })}
                    placeholder="Piso, puerta o departamento (opcional)"
                    className="rounded-lg p-2.5 text-sm"
                    style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={address.city}
                      onChange={(e) => setAddress({ ...address, city: e.target.value })}
                      onBlur={() => setTouched(true)}
                      placeholder="Ciudad"
                      className="rounded-lg p-2.5 text-sm"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                    <select
                      value={address.state}
                      onChange={(e) => setAddress({ ...address, state: e.target.value })}
                      onBlur={() => setTouched(true)}
                      className="rounded-lg p-2.5 text-sm"
                      style={{ background: "var(--ink-3)", color: address.state ? "var(--bone)" : "var(--slate)", border: "1px solid var(--line)" }}
                    >
                      <option value="">Provincia / comunidad</option>
                      {SPAIN_REGIONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      value={address.postalCode}
                      onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                      onBlur={() => setTouched(true)}
                      placeholder="Código postal"
                      className="rounded-lg p-2.5 text-sm"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                    <input
                      value={address.country}
                      onChange={(e) => setAddress({ ...address, country: e.target.value })}
                      placeholder="País"
                      className="rounded-lg p-2.5 text-sm"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                  </div>
                  <textarea
                    value={address.reference}
                    onChange={(e) => setAddress({ ...address, reference: e.target.value })}
                    placeholder="Comentario para la entrega: color de puerta, horario, referencia (opcional)"
                    rows={2}
                    className="rounded-lg p-2.5 text-sm"
                    style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  />
                  {touched && !addressOk && (
                    <p className="text-xs" style={{ color: "var(--signal)" }}>Completa al menos calle, ciudad, provincia y código postal para el envío.</p>
                  )}
                  {!freeShipping && (
                    <p className="text-xs" style={{ color: "var(--slate)" }}>
                      Te faltan {formatPrice(settings.freeShippingThreshold - subtotal)} para envío gratis.
                    </p>
                  )}
                </div>
              )}

              <div className="flex flex-col gap-1 text-sm" style={{ color: "var(--slate)" }}>
                <div className="flex items-center justify-between">
                  <span>Subtotal</span>
                  <span style={{ color: "var(--bone)" }}>{formatPrice(subtotal)}</span>
                </div>
                {discountAmount > 0 && (
                  <div className="flex items-center justify-between" style={{ color: "var(--sun)" }}>
                    <span>Descuento de bienvenida ({settings.signupDiscountPercent}%)</span>
                    <span>-{formatPrice(discountAmount)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span>Envío</span>
                  <span style={{ color: "var(--bone)" }}>{deliveryMethod === "envio" ? (shippingCost > 0 ? formatPrice(shippingCost) : "Gratis") : "Recoges en persona"}</span>
                </div>
                <div className="flex items-center justify-between text-base font-bold mt-1" style={{ color: "var(--bone)" }}>
                  <span>Total</span>
                  <span>{formatPrice(total)}</span>
                </div>
                {customer && settings?.loyaltyEnabled && (
                  <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
                    Vas a sumar {pointsEarned} puntos con este pedido.
                  </p>
                )}
              </div>
              <button
                disabled={sending || !canCheckout}
                onClick={() => { setTouched(true); if (canCheckout) onCheckout({ subtotal, shippingCost, total, discountAmount, itemCount }); }}
                className="kulto-btn w-full rounded-full py-3 font-semibold flex items-center justify-center gap-2"
                style={{ background: !canCheckout ? "var(--ink-3)" : "var(--signal)", color: !canCheckout ? "var(--slate)" : "var(--bone)", cursor: !canCheckout ? "not-allowed" : "pointer" }}
              >
                {sending ? <Loader2 size={18} className="animate-spin" /> : <MessageCircle size={18} />}
                Enviar pedido por WhatsApp
              </button>
              <p className="text-xs text-center" style={{ color: "var(--slate)" }}>
                Se abrirá WhatsApp con tu pedido listo para enviar a Kulto.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Order confirmation                                                 */
/* ------------------------------------------------------------------ */

function OrderConfirm({ orderId, hasCustom, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="rounded-3xl p-8 max-w-sm w-full text-center" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
        <div className="w-14 h-14 rounded-full mx-auto flex items-center justify-center mb-4" style={{ background: "var(--sun)" }}>
          <Check size={28} color="var(--ink)" />
        </div>
        <h3 className="kulto-display text-xl mb-2" style={{ color: "var(--bone)" }}>Pedido enviado</h3>
        <p className="text-sm mb-1" style={{ color: "var(--slate)" }}>Tu número de orden es:</p>
        <p className="font-bold text-lg mb-5" style={{ color: "var(--sun)" }}>{orderId}</p>
        <p className="text-sm mb-3" style={{ color: "var(--slate)" }}>Confirma el envío en la ventana de WhatsApp que se abrió. Guarda este número por si necesitas escribirnos.</p>
        {hasCustom && (
          <p className="text-sm mb-6" style={{ color: "var(--sun)" }}>
            Como incluye una prenda personalizada, puede demorar entre 3 y 7 días. Si la necesitás antes, avisanos por WhatsApp.
          </p>
        )}
        <button onClick={onClose} className="kulto-btn w-full rounded-full py-3 font-semibold" style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}>
          Cerrar
        </button>
      </div>
    </div>
  );
}

function LeaveReviewSection({ order }) {
  const [checking, setChecking] = useState(true);
  const [existing, setExisting] = useState(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(order.customerName || "");
  const [rating, setRating] = useState(5);
  const [text, setText] = useState("");
  const [photo, setPhoto] = useState(null);
  const [submitted, setSubmitted] = useState(false);

  const handlePhotoUpload = async (file) => {
    if (!file) return;
    // Siempre se convierte a JPG (sea cual sea el formato subido), para que
    // todas las fotos de reseñas pesen y se vean de forma consistente.
    const b64 = await new Promise((resolve) => fileToBase64(file, resolve, 1000, 0.85, "image/jpeg"));
    setPhoto(b64);
  };

  const productNames = [...new Set(order.items.map((i) => i.name))];
  const productIds = [...new Set(order.items.map((i) => i.productId).filter(Boolean))];

  useEffect(() => {
    setChecking(true);
    setOpen(false);
    setSubmitted(false);
    loadReviews().then((all) => {
      setExisting(all.find((r) => r.orderId === order.id) || null);
      setChecking(false);
    });
  }, [order.id]);

  const submit = async () => {
    if (!name.trim() || !text.trim()) return;
    const review = {
      id: genId("rev"),
      name: name.trim(),
      rating,
      text: text.trim(),
      photo: photo || null,
      source: "customer",
      status: "pendiente",
      orderId: order.id,
      items: productNames,
      productIds,
      date: new Date().toISOString(),
    };
    await persistReview(review);
    setExisting(review);
    setSubmitted(true);
  };

  if (checking) return null;

  return (
    <div className="rounded-2xl p-5 mt-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      {existing ? (
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>
            {submitted ? "¡Gracias por tu reseña!" : "Ya dejaste una reseña para este pedido"}
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
            {existing.status === "pendiente"
              ? "La estamos revisando antes de publicarla."
              : "Ya está publicada en la web."}
          </p>
        </div>
      ) : !open ? (
        <button onClick={() => setOpen(true)} className="kulto-btn w-full rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: "var(--sun)", color: "var(--ink)" }}>
          <Star size={16} /> Dejar una reseña de {productNames.length > 1 ? "esta compra" : productNames[0]}
        </button>
      ) : (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Tu reseña de:</p>
            <p className="text-xs" style={{ color: "var(--slate)" }}>{productNames.join(", ")}</p>
          </div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tu nombre"
            className="rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
          <div>
            <p className="text-sm mb-1" style={{ color: "var(--bone)" }}>Puntaje</p>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} onClick={() => setRating(n)} className="kulto-btn">
                  <Star size={24} fill={n <= rating ? "var(--sun)" : "none"} color="var(--sun)" />
                </button>
              ))}
            </div>
          </div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Contanos qué te pareció"
            rows={3}
            className="rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
          <div>
            <p className="text-sm mb-1" style={{ color: "var(--bone)" }}>Foto (opcional)</p>
            {photo ? (
              <div className="flex items-center gap-2">
                <img loading="lazy" src={photo} className="w-14 h-14 rounded-lg object-cover" alt="Tu foto" />
                <button onClick={() => setPhoto(null)} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ border: "1px solid var(--line)", color: "var(--slate)" }}>Quitar</button>
              </div>
            ) : (
              <label className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full cursor-pointer inline-flex items-center gap-1" style={{ border: "1px solid var(--line)", color: "var(--bone)" }}>
                <Upload size={13} /> Subir foto de tu prenda
                <input type="file" accept="image/png, image/jpeg" className="hidden" onChange={(e) => handlePhotoUpload(e.target.files?.[0])} />
              </label>
            )}
          </div>
          <button onClick={submit} className="kulto-btn rounded-full py-3 font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            Enviar reseña
          </button>
          <p className="text-xs" style={{ color: "var(--slate)" }}>La revisamos antes de publicarla en la web.</p>
        </div>
      )}
    </div>
  );
}

function AccountPage({ customer, onRegister, onLogin, onLogout, onVerifyEmail, onResendVerification, onRequestPasswordReset, onResetPassword, settings, initialResetEmail, initialResetCode }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);

  // Link del mail "Recuperar contraseña" (?resetEmail=&resetCode=): lleva
  // directo al formulario de contraseña nueva con el email y el código ya
  // cargados, sin que el cliente tenga que copiarlos a mano.
  useEffect(() => {
    if (initialResetEmail && initialResetCode) {
      setEmail(initialResetEmail);
      setCode(initialResetCode);
      setMode("resetPassword");
    }
  }, [initialResetEmail, initialResetCode]);

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  if (customer) {
    const threshold = Number(settings?.loyaltyRewardThreshold) || 5;
    const progressInCycle = (customer.points || 0) % threshold;
    return (
      <div className="max-w-md mx-auto px-4 md:px-6 py-10">
        <SectionTitle eyebrow="Tu cuenta" title={`Hola, ${customer.name || customer.email}`} />
        <div className="rounded-2xl p-5 flex flex-col gap-3 mt-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <p className="text-sm" style={{ color: "var(--bone)" }}>Email: {customer.email}</p>
          {settings?.signupDiscountEnabled && (
            <p className="text-sm" style={{ color: customer.firstDiscountUsed ? "var(--slate)" : "var(--sun)" }}>
              {customer.firstDiscountUsed
                ? "Ya usaste tu descuento de bienvenida."
                : `Tenés ${settings.signupDiscountPercent}% de descuento disponible — se aplica automáticamente en tu próxima compra.`}
            </p>
          )}
          {settings?.loyaltyEnabled && (
            <div>
              <p className="text-sm mb-1" style={{ color: "var(--bone)" }}>Puntos: {customer.points || 0}</p>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: "var(--ink-3)" }}>
                <div className="h-full" style={{ width: `${Math.min(100, (progressInCycle / threshold) * 100)}%`, background: "var(--sun)" }} />
              </div>
              {settings.loyaltyRewardDescription && <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>{settings.loyaltyRewardDescription}</p>}
            </div>
          )}
          <button onClick={onLogout} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full mt-2" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            Cerrar sesión
          </button>
        </div>
      </div>
    );
  }

  const submit = async () => {
    setError("");
    setInfo("");
    if (!email.trim() || !password) { setError("Completá email y contraseña."); return; }
    if (!isValidEmail(email.trim())) { setError("Ingresá un email válido."); return; }
    setLoading(true);
    const result = mode === "register" ? await onRegister({ name, email, password }) : await onLogin({ email, password });
    setLoading(false);
    if (result.needsVerification) {
      setMode("verify");
      if (result.error) setInfo(result.error);
      return;
    }
    if (!result.ok) setError(result.error);
  };

  const submitCode = async () => {
    setError("");
    if (!code.trim()) { setError("Ingresá el código que te mandamos por mail."); return; }
    setLoading(true);
    const result = await onVerifyEmail({ email, code });
    setLoading(false);
    if (!result.ok) setError(result.error);
  };

  const resendCode = async () => {
    setError("");
    setInfo("");
    setResending(true);
    const result = await onResendVerification({ email });
    setResending(false);
    if (result.ok) setInfo("Te mandamos un código nuevo — revisá tu casilla (y spam, por las dudas).");
    else setError(result.error);
  };

  const submitForgot = async () => {
    setError("");
    setInfo("");
    if (!email.trim() || !isValidEmail(email.trim())) { setError("Ingresá un email válido."); return; }
    setLoading(true);
    const result = await onRequestPasswordReset({ email });
    setLoading(false);
    if (!result.ok) { setError(result.error); return; }
    setCode("");
    setNewPassword("");
    setMode("resetPassword");
  };

  const resendReset = async () => {
    setError("");
    setInfo("");
    setResending(true);
    const result = await onRequestPasswordReset({ email });
    setResending(false);
    if (result.ok) setInfo("Te mandamos un código nuevo — revisá tu casilla (y spam, por las dudas).");
    else setError(result.error);
  };

  const submitReset = async () => {
    setError("");
    setInfo("");
    if (!code.trim()) { setError("Ingresá el código que te mandamos por mail."); return; }
    if (!newPassword || newPassword.length < 6) { setError("La contraseña nueva debe tener al menos 6 caracteres."); return; }
    setLoading(true);
    const result = await onResetPassword({ email, code, newPassword });
    setLoading(false);
    if (!result.ok) setError(result.error);
  };

  if (mode === "forgot") {
    return (
      <div className="max-w-md mx-auto px-4 md:px-6 py-10">
        <SectionTitle eyebrow="Tu cuenta" title="Recuperar contraseña" />
        <p className="text-sm mt-3" style={{ color: "var(--slate)" }}>
          Ingresá el mail de tu cuenta y te mandamos un código para elegir una contraseña nueva.
        </p>
        <div className="flex flex-col gap-3 mt-4">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-xl p-3 text-sm" style={inputStyle} />
          {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
          <button disabled={loading} onClick={submitForgot} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : "Mandar código"}
          </button>
          <button onClick={() => { setMode("login"); setError(""); setInfo(""); }} className="kulto-btn text-xs" style={{ color: "var(--slate)" }}>
            Volver a iniciar sesión
          </button>
        </div>
      </div>
    );
  }

  if (mode === "resetPassword") {
    return (
      <div className="max-w-md mx-auto px-4 md:px-6 py-10">
        <SectionTitle eyebrow="Tu cuenta" title="Elegí una contraseña nueva" />
        <p className="text-sm mt-3" style={{ color: "var(--slate)" }}>
          Te mandamos un código de 6 dígitos a <strong style={{ color: "var(--bone)" }}>{email}</strong>. Ingresalo junto con tu contraseña nueva.
        </p>
        <div className="flex flex-col gap-3 mt-4">
          <input
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="rounded-xl p-3 text-center text-2xl tracking-[0.5em] font-bold"
            style={inputStyle}
            inputMode="numeric"
          />
          <input type="password" placeholder="Contraseña nueva" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="rounded-xl p-3 text-sm" style={inputStyle} />
          {info && <p className="text-xs" style={{ color: "var(--sun)" }}>{info}</p>}
          {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
          <button disabled={loading} onClick={submitReset} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : "Guardar contraseña"}
          </button>
          <button disabled={resending} onClick={resendReset} className="kulto-btn text-sm font-semibold py-2" style={{ color: "var(--bone)" }}>
            {resending ? "Enviando..." : "Reenviar código"}
          </button>
          <button onClick={() => { setMode("login"); setError(""); setInfo(""); }} className="kulto-btn text-xs" style={{ color: "var(--slate)" }}>
            Volver a iniciar sesión
          </button>
        </div>
      </div>
    );
  }

  if (mode === "verify") {
    return (
      <div className="max-w-md mx-auto px-4 md:px-6 py-10">
        <SectionTitle eyebrow="Tu cuenta" title="Confirmá tu mail" />
        <p className="text-sm mt-3" style={{ color: "var(--slate)" }}>
          Te mandamos un código de 6 dígitos a <strong style={{ color: "var(--bone)" }}>{email}</strong>. Ingresalo acá para activar tu cuenta.
        </p>
        <div className="flex flex-col gap-3 mt-4">
          <input
            placeholder="000000"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className="rounded-xl p-3 text-center text-2xl tracking-[0.5em] font-bold"
            style={inputStyle}
            inputMode="numeric"
          />
          {info && <p className="text-xs" style={{ color: "var(--sun)" }}>{info}</p>}
          {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
          <button disabled={loading} onClick={submitCode} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            {loading ? <Loader2 size={16} className="animate-spin" /> : "Confirmar cuenta"}
          </button>
          <button disabled={resending} onClick={resendCode} className="kulto-btn text-sm font-semibold py-2" style={{ color: "var(--bone)" }}>
            {resending ? "Enviando..." : "Reenviar código"}
          </button>
          <button onClick={() => { setMode("login"); setError(""); setInfo(""); }} className="kulto-btn text-xs" style={{ color: "var(--slate)" }}>
            Volver a iniciar sesión
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 md:px-6 py-10">
      <SectionTitle eyebrow="Tu cuenta" title={mode === "login" ? "Iniciar sesión" : "Crear cuenta"} />
      <div className="flex gap-2 mb-5 mt-4">
        <button onClick={() => { setMode("login"); setError(""); }} className="kulto-btn flex-1 text-sm font-semibold py-2 rounded-full" style={{ background: mode === "login" ? "var(--signal)" : "var(--ink-2)", color: "var(--bone)" }}>Ingresar</button>
        <button onClick={() => { setMode("register"); setError(""); }} className="kulto-btn flex-1 text-sm font-semibold py-2 rounded-full" style={{ background: mode === "register" ? "var(--signal)" : "var(--ink-2)", color: "var(--bone)" }}>Registrarme</button>
      </div>
      {mode === "register" && settings?.signupDiscountEnabled && (
        <p className="text-xs mb-3 rounded-xl p-3" style={{ background: "var(--ink-2)", color: "var(--sun)" }}>
          Registrate y llevate {settings.signupDiscountPercent}% de descuento en tu primera compra.
        </p>
      )}
      <div className="flex flex-col gap-3">
        {mode === "register" && (
          <input placeholder="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl p-3 text-sm" style={inputStyle} />
        )}
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-xl p-3 text-sm" style={inputStyle} />
        <input type="password" placeholder="Contraseña" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-xl p-3 text-sm" style={inputStyle} />
        {mode === "login" && (
          <button type="button" onClick={() => { setMode("forgot"); setError(""); setInfo(""); }} className="kulto-btn text-xs self-start -mt-1" style={{ color: "var(--slate)" }}>
            ¿Olvidaste tu contraseña?
          </button>
        )}
        {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
        <button disabled={loading} onClick={submit} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center" style={{ background: "var(--signal)", color: "var(--bone)" }}>
          {loading ? <Loader2 size={16} className="animate-spin" /> : mode === "login" ? "Ingresar" : "Crear cuenta"}
        </button>
      </div>
    </div>
  );
}

function OrderLookupPage({ initialOrderId = "" }) {
  const [orderId, setOrderId] = useState(initialOrderId);
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | notfound

  const search = async (idOverride) => {
    const id = (idOverride ?? orderId).trim();
    if (!id) return;
    setStatus("loading");
    const found = await findOrderById(id);
    if (found) { setResult(found); setStatus("idle"); }
    else { setResult(null); setStatus("notfound"); }
  };

  // Si llegamos acá con un número de pedido ya cargado (ej: desde el link del
  // mail "Pedir reseña"), buscamos automáticamente sin que el cliente tenga
  // que tocar nada.
  useEffect(() => {
    if (initialOrderId.trim()) search(initialOrderId);
  }, [initialOrderId]);

  const trackingIsLink = result?.trackingNumber?.trim().startsWith("http");

  return (
    <div className="max-w-lg mx-auto px-4 md:px-6 py-14">
      <SectionTitle eyebrow="¿Dónde está tu pedido?" title="Seguir mi pedido" />
      <p className="text-sm mb-4" style={{ color: "var(--slate)" }}>
        Escribí el número de orden que te dimos por WhatsApp al confirmar la compra (por ejemplo, KULTO-260914-AB12).
      </p>
      <div className="flex gap-2 mb-6">
        <input
          value={orderId}
          onChange={(e) => setOrderId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="N° de orden"
          className="flex-1 rounded-xl p-3 text-sm"
          style={{ background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}
        />
        <button onClick={() => search()} className="kulto-btn rounded-xl px-5 font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
          Buscar
        </button>
      </div>

      {status === "loading" && <p className="text-sm" style={{ color: "var(--slate)" }}>Buscando...</p>}
      {status === "notfound" && (
        <p className="text-sm" style={{ color: "var(--signal)" }}>No encontramos un pedido con ese número. Revisá que esté bien escrito.</p>
      )}

      {result && (
        <div className="rounded-2xl p-5 flex flex-col gap-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <div className="flex items-center justify-between">
            <p className="font-bold" style={{ color: "var(--bone)" }}>{result.id}</p>
            <span
              className="text-xs font-semibold px-3 py-1 rounded-full"
              style={{ background: result.status === "completado" ? "var(--sun)" : "var(--ink-3)", color: result.status === "completado" ? "var(--ink)" : "var(--bone)" }}
            >
              {result.status === "completado" ? "Completado" : "Pendiente"}
            </span>
          </div>
          <p className="text-xs" style={{ color: "var(--slate)" }}>{formatDate(result.date)} · {result.items.length} artículo(s) · {formatPrice(result.total)}</p>
          <p className="text-xs" style={{ color: "var(--slate)" }}>
            Entrega: {result.deliveryMethod === "envio" ? "Envío a domicilio" : "Recoge en persona"}
          </p>
          {(result.deliveryMethod === "envio" || result.trackingNumber) && (
            <div className="pt-2" style={{ borderTop: "1px solid var(--line)" }}>
              <p className="text-sm font-semibold mb-1" style={{ color: "var(--bone)" }}>Seguimiento</p>
              {result.trackingNumber ? (
                trackingIsLink ? (
                  <a href={result.trackingNumber} target="_blank" rel="noreferrer" className="text-sm underline" style={{ color: "var(--sun)" }}>
                    Ver seguimiento del envío
                  </a>
                ) : (
                  <p className="text-sm" style={{ color: "var(--sun)" }}>{result.trackingNumber}</p>
                )
              ) : (
                <p className="text-sm" style={{ color: "var(--slate)" }}>Todavía no cargamos el número de seguimiento. Te avisamos por WhatsApp apenas lo tengamos.</p>
              )}
            </div>
          )}
        </div>
      )}
      {result && <LeaveReviewSection order={result} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Admin panel                                                        */
/* ------------------------------------------------------------------ */

const SIZE_PRESETS = ["XS", "S", "M", "L", "XL", "XXL", "3XL"];

/* ------------------------------------------------------------------ */
/*  Crop tool — lets the admin choose exactly what part of a photo     */
/*  shows, instead of an automatic (and sometimes surprising) crop.    */
/* ------------------------------------------------------------------ */

const CROP_FRAME_W = 300;
const CROP_FRAME_H = 375; // 4:5, matches how photos are shown across the site
const CROP_OUT_W = 1000;
const CROP_OUT_H = 1250;

function CropModal({ source, onConfirm, onCancel, frameW = CROP_FRAME_W, frameH = CROP_FRAME_H, outW = CROP_OUT_W, outH = CROP_OUT_H, title = "Elegí qué parte de la foto se ve", fitMode = "cover" }) {
  const [img, setImg] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [mimeType, setMimeType] = useState("image/jpeg");
  const dragState = useRef(null);

  // El marco de recorte se ve más chico en pantallas angostas para que
  // siempre entre dentro del modal (antes tenía un tamaño fijo en píxeles
  // que se podía cortar en celulares chicos) — el resultado final se sigue
  // exportando siempre al mismo tamaño (outW x outH), sin importar el
  // celular. La proporción del marco (frameW/frameH) se mantiene igual.
  const [viewportW, setViewportW] = useState(typeof window !== "undefined" ? window.innerWidth : 400);
  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const maxBoxW = Math.max(180, viewportW - 96);
  const boxW = Math.min(frameW, maxBoxW);
  const boxH = boxW * (frameH / frameW);

  // "cover" (por defecto) llena el marco entero sin dejar espacios, recortando
  // lo que sobre — ideal cuando el resultado tiene que verse parejo con otros
  // (banners, fotos de producto). "contain" en cambio muestra la foto completa
  // sin cortar nada de entrada (con un margen si la proporción no coincide),
  // dejando que el zoom sea opcional para quien sí quiera recortar más de cerca.
  const getBaseScale = (nw, nh) => (fitMode === "contain" ? Math.min(boxW / nw, boxH / nh) : Math.max(boxW / nw, boxH / nh));
  const baseScale = img ? getBaseScale(img.naturalWidth, img.naturalHeight) : 1;
  const displayScale = baseScale * zoom;
  const displayW = img ? img.naturalWidth * displayScale : 0;
  const displayH = img ? img.naturalHeight * displayScale : 0;

  const clamp = (p, w, h) => ({
    x: w <= boxW ? (boxW - w) / 2 : Math.min(0, Math.max(boxW - w, p.x)),
    y: h <= boxH ? (boxH - h) / 2 : Math.min(0, Math.max(boxH - h, p.y)),
  });

  useEffect(() => {
    let url;
    let isFile = source instanceof File || source instanceof Blob;
    if (isFile) {
      setMimeType(source.type === "image/png" ? "image/png" : "image/jpeg");
      url = URL.createObjectURL(source);
    } else {
      const m = source.match(/^data:(image\/[a-zA-Z+]+);base64,/);
      setMimeType(m && m[1] === "image/png" ? "image/png" : "image/jpeg");
      url = source;
    }
    const image = new Image();
    // Al recortar de nuevo una foto que ya está en Supabase Storage (URL
    // remota, no texto embebido), hace falta "crossOrigin" para poder
    // exportar el canvas después — si no, toDataURL() tira un error.
    image.crossOrigin = "anonymous";
    image.onload = () => {
      setImg(image);
      const bScale = getBaseScale(image.naturalWidth, image.naturalHeight);
      setZoom(1);
      setPan({ x: (boxW - image.naturalWidth * bScale) / 2, y: (boxH - image.naturalHeight * bScale) / 2 });
    };
    image.src = url;
    return () => { if (isFile) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  const startDrag = (clientX, clientY) => {
    dragState.current = { startX: clientX, startY: clientY, panX: pan.x, panY: pan.y };
  };
  const moveDrag = (clientX, clientY) => {
    if (!dragState.current) return;
    const dx = clientX - dragState.current.startX;
    const dy = clientY - dragState.current.startY;
    setPan(clamp({ x: dragState.current.panX + dx, y: dragState.current.panY + dy }, displayW, displayH));
  };
  const endDrag = () => { dragState.current = null; };

  const handleZoom = (newZoom) => {
    const z = Math.max(1, Math.min(3, newZoom));
    if (!img) { setZoom(z); return; }
    const newScale = baseScale * z;
    const newW = img.naturalWidth * newScale;
    const newH = img.naturalHeight * newScale;
    // keep the frame's center point anchored while zooming
    const cx = boxW / 2, cy = boxH / 2;
    const ratioX = (cx - pan.x) / displayW;
    const ratioY = (cy - pan.y) / displayH;
    const newPan = clamp({ x: cx - ratioX * newW, y: cy - ratioY * newH }, newW, newH);
    setZoom(z);
    setPan(newPan);
  };

  const confirm = () => {
    if (!img) return;
    const sourceX = -pan.x / displayScale;
    const sourceY = -pan.y / displayScale;
    const sourceW = boxW / displayScale;
    const sourceH = boxH / displayScale;
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (fitMode === "contain") {
      // en "contain" puede quedar un margen si la proporción de la foto no
      // coincide con la del marco — lo pintamos con el mismo tono de fondo
      // que usan las tarjetas, para que se vea prolijo en vez de transparente.
      let bg = "#241f2b";
      try {
        const v = getComputedStyle(document.documentElement).getPropertyValue("--ink-3").trim();
        if (v) bg = v;
      } catch { /* usamos el color de respaldo */ }
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, outW, outH);
    }
    ctx.drawImage(img, sourceX, sourceY, sourceW, sourceH, 0, 0, outW, outH);
    const quality = mimeType === "image/png" ? 1 : 0.85;
    try {
      onConfirm(canvas.toDataURL(mimeType, quality));
    } catch {
      alert("No se pudo procesar esta foto. Probá subiéndola de nuevo desde el archivo original.");
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.85)" }}>
      <div className="rounded-2xl p-5 max-w-sm w-full flex flex-col gap-4" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
        <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>{title}</p>
        <div
          className="relative overflow-hidden rounded-xl mx-auto touch-none select-none"
          style={{ width: boxW, height: boxH, background: "var(--ink-3)", cursor: img ? "grab" : "default" }}
          onMouseDown={(e) => startDrag(e.clientX, e.clientY)}
          onMouseMove={(e) => { if (dragState.current) moveDrag(e.clientX, e.clientY); }}
          onMouseUp={endDrag}
          onMouseLeave={endDrag}
          onTouchStart={(e) => startDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchMove={(e) => moveDrag(e.touches[0].clientX, e.touches[0].clientY)}
          onTouchEnd={endDrag}
        >
          {img && (
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{ position: "absolute", left: pan.x, top: pan.y, width: displayW, height: displayH, maxWidth: "none" }}
            />
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: "var(--slate)" }}>Zoom</span>
          <input
            type="range"
            min="1"
            max="3"
            step="0.01"
            value={zoom}
            onChange={(e) => handleZoom(Number(e.target.value))}
            className="flex-1"
          />
        </div>
        <p className="text-xs" style={{ color: "var(--slate)" }}>Arrastrá la foto para moverla dentro del marco.</p>
        <div className="flex gap-2">
          <button onClick={onCancel} className="kulto-btn flex-1 rounded-full py-2.5 text-sm font-semibold" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            Cancelar
          </button>
          <button onClick={confirm} disabled={!img} className="kulto-btn flex-1 rounded-full py-2.5 text-sm font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            Usar esta foto
          </button>
        </div>
      </div>
    </div>
  );
}

const emptyDraft = {
  id: null, name: "", description: "", category: "", group: "", price: "", salePrice: "", stock: "", points: "", sku: "",
  tags: { bestseller: false, oferta: false, tendencia: false, template: false, customDesign: false },
  colors: [], designs: [], sizes: [], photoPool: [],
  imageFit: "contain", imageBackground: null,
  sizeGuide: [], // [{ size, measurements }] — guía de talles opcional, por prenda
  sizeGuideImage: null, // alternativa (o complemento) a la tabla: una foto con las medidas
  designGroup: "", // opcional: mismo texto en varios productos = "mismo diseño, otro estilo"
};

function AdminProductForm({ categories, groups, onAddCategory, onAddGroup, savedColors, onSaveColorToLibrary, onRemoveColorFromLibrary, onSave, editing, onCancelEdit, defaultTemplate = false, allProducts = [] }) {
  const [draft, setDraft] = useState(emptyDraft);
  const [newCat, setNewCat] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [colorDraft, setColorDraft] = useState({ name: "", hex: "#E8452C", images: [], frontImage: null, backImage: null, sleeveLeftImage: null, sleeveRightImage: null });
  const [colorError, setColorError] = useState("");
  // Cola de colores de Roly cargados por número, esperando su foto — ver
  // "Agregar por número de Roly" más abajo.
  const [rolyInput, setRolyInput] = useState("");
  const [rolyQueue, setRolyQueue] = useState([]);
  const [rolyNotFound, setRolyNotFound] = useState([]);
  const [designDraft, setDesignDraft] = useState({ name: "", image: "" });
  const [editingColorIdx, setEditingColorIdx] = useState(null);
  const [editingDesignIdx, setEditingDesignIdx] = useState(null);
  const [customSize, setCustomSize] = useState("");
  const [saving, setSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  // Al crear una prenda nueva, la mostramos paso a paso (como Personalizar) en
  // vez de un formulario larguísimo de una — más fácil de seguir sin perderse.
  // Al editar una ya existente dejamos todo visible junto, como hasta ahora,
  // para poder retocar cualquier cosa sin ir paso por paso de nuevo.
  const [step, setStep] = useState(1);
  const isNew = !draft.id;
  const TOTAL_STEPS = 4;
  const showStep = (n) => !isNew || step === n;

  useEffect(() => {
    if (editing) {
      const migratedColors = (editing.colors || []).map((c) => ({
        name: c.name, hex: c.hex, images: c.images || (c.image ? [c.image] : []),
      }));
      setDraft({
        ...emptyDraft,
        ...editing,
        // editing.points puede venir en null (prenda guardada sin puntaje
        // propio) — un input controlado no acepta null, así que lo pasamos a
        // "" para que se vea vacío en vez de romper el campo.
        points: editing.points == null ? "" : String(editing.points),
        sizes: editing.sizes || [],
        colors: migratedColors,
        photoPool: editing.photoPool || migratedColors.flatMap((c) => c.images),
      });
    } else {
      setDraft({ ...emptyDraft, tags: { ...emptyDraft.tags, template: defaultTemplate } });
    }
    setEditingColorIdx(null);
    setEditingDesignIdx(null);
    setColorDraft({ name: "", hex: "#E8452C", images: [], frontImage: null, backImage: null, sleeveLeftImage: null, sleeveRightImage: null });
    setDesignDraft({ name: "", image: "" });
    setCustomSize("");
    setShowAdvanced(false);
    setAiError("");
    setStep(1);
  }, [editing, defaultTemplate]);

  const [cropQueue, setCropQueue] = useState([]); // File objects waiting to be cropped
  const [cropSource, setCropSource] = useState(null); // currently open: File or existing base64 string (re-crop)
  const [recropTarget, setRecropTarget] = useState(null); // existing base64 being replaced, if re-cropping

  const addPhotosToPool = (files) => {
    const list = Array.from(files);
    if (!list.length) return;
    setCropQueue(list.slice(1));
    setCropSource(list[0]);
  };
  const handleCropConfirm = (croppedBase64) => {
    if (recropTarget) {
      setDraft((d) => ({
        ...d,
        photoPool: d.photoPool.map((p) => (p === recropTarget ? croppedBase64 : p)),
        colors: d.colors.map((c) => ({ ...c, images: c.images.map((i) => (i === recropTarget ? croppedBase64 : i)) })),
      }));
      setColorDraft((c) => ({ ...c, images: c.images.map((i) => (i === recropTarget ? croppedBase64 : i)) }));
      setRecropTarget(null);
      setCropSource(null);
      return;
    }
    setDraft((d) => ({ ...d, photoPool: [...d.photoPool, croppedBase64] }));
    if (cropQueue.length) {
      setCropSource(cropQueue[0]);
      setCropQueue((q) => q.slice(1));
    } else {
      setCropSource(null);
    }
  };
  const handleCropCancel = () => {
    setRecropTarget(null);
    if (recropTarget) { setCropSource(null); return; }
    if (cropQueue.length) {
      setCropSource(cropQueue[0]);
      setCropQueue((q) => q.slice(1));
    } else {
      setCropSource(null);
    }
  };
  const recropPoolImage = (img) => { setRecropTarget(img); setCropSource(img); };
  const removeFromPool = (img) => {
    setDraft((d) => ({ ...d, photoPool: d.photoPool.filter((p) => p !== img) }));
  };
  const resortColorsToPool = (colors, pool) =>
    colors.map((c) => ({ ...c, images: [...c.images].sort((a, b) => pool.indexOf(a) - pool.indexOf(b)) }));

  const movePoolImage = (index, direction) => {
    setDraft((d) => {
      const next = [...d.photoPool];
      const target = index + direction;
      if (target < 0 || target >= next.length) return d;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...d, photoPool: next, colors: resortColorsToPool(d.colors, next) };
    });
  };
  const makeCoverImage = (index) => {
    setDraft((d) => {
      if (index === 0) return d;
      const next = [...d.photoPool];
      const [img] = next.splice(index, 1);
      next.unshift(img);
      return { ...d, photoPool: next, colors: resortColorsToPool(d.colors, next) };
    });
  };
  // Las 4 zonas que un admin puede marcar en una foto vinculada a un color:
  // adelante, atrás y (opcionalmente) manga izquierda/derecha por separado.
  const ZONE_FIELDS = ["frontImage", "backImage", "sleeveLeftImage", "sleeveRightImage"];
  const togglePoolImageOnColor = (img) => {
    setColorDraft((c) => {
      const included = c.images.includes(img);
      const next = { ...c, images: included ? c.images.filter((i) => i !== img) : [...c.images, img] };
      if (included) {
        ZONE_FIELDS.forEach((f) => { if (next[f] === img) next[f] = null; });
      }
      return next;
    });
  };
  const setColorZoneImage = (zone, img) => {
    setColorDraft((c) => {
      const next = { ...c, [zone]: c[zone] === img ? null : img };
      // una misma foto no puede ser a la vez, por ejemplo, "adelante" y "manga izquierda"
      ZONE_FIELDS.forEach((f) => { if (f !== zone && next[f] === img) next[f] = null; });
      return next;
    });
  };
  // Subida directa: tocás el recuadro "Adelante"/"Atrás"/etc. y elegís la foto
  // de una — sin tener que subirla primero arriba y después ir a marcarla.
  const ZONE_UPLOAD_DEFS = [
    { key: "frontImage", label: "Adelante" },
    { key: "backImage", label: "Atrás" },
    { key: "sleeveLeftImage", label: "Manga izq." },
    { key: "sleeveRightImage", label: "Manga der." },
  ];
  const colorHasAnyZoneImage = (c) => ZONE_FIELDS.some((f) => !!c[f]);
  const handleZoneUpload = (zone, file) => {
    if (!file) return;
    const isPng = file.type === "image/png";
    fileToBase64(
      file,
      (b64) => {
        setColorDraft((c) => {
          const next = { ...c, [zone]: b64 };
          ZONE_FIELDS.forEach((f) => { if (f !== zone && next[f] === b64) next[f] = null; });
          if (!next.images.includes(b64)) next.images = [...next.images, b64];
          return next;
        });
      },
      1400,
      isPng ? 1 : 0.9,
      isPng ? "image/png" : "image/jpeg"
    );
  };
  const removeZoneImage = (zone) => {
    setColorDraft((c) => {
      const img = c[zone];
      const next = { ...c, [zone]: null };
      const stillUsed = ZONE_FIELDS.some((f) => f !== zone && next[f] === img);
      if (img && !stillUsed) next.images = next.images.filter((i) => i !== img);
      return next;
    });
  };

  const handleAiFill = async () => {
    if (!draft.photoPool.length) return;
    setAiLoading(true);
    setAiError("");
    const result = await analyzeProductPhoto(draft.photoPool[0], categories);
    setAiLoading(false);
    if (!result.ok) {
      setAiError(result.error);
      return;
    }
    setDraft((d) => ({
      ...d,
      name: result.name || d.name,
      category: result.category || d.category,
      description: result.description || d.description,
    }));
    if (result.category && !categories.includes(result.category)) {
      onAddCategory(result.category);
    }
  };

  const addColor = () => {
    if (!colorHasAnyZoneImage(colorDraft)) {
      setColorError("Subí al menos una foto (adelante, atrás o alguna manga) antes de guardar el color.");
      return;
    }
    setColorError("");
    const finalColor = colorDraft.name.trim()
      ? colorDraft
      : { ...colorDraft, name: `Color ${draft.colors.length + 1}` };
    if (editingColorIdx !== null) {
      setDraft((d) => ({ ...d, colors: d.colors.map((c, idx) => (idx === editingColorIdx ? finalColor : c)) }));
      setEditingColorIdx(null);
    } else {
      setDraft((d) => ({ ...d, colors: [...d.colors, finalColor] }));
    }
    onSaveColorToLibrary?.({ name: finalColor.name, hex: finalColor.hex });
    setColorDraft({ name: "", hex: "#E8452C", images: [], frontImage: null, backImage: null, sleeveLeftImage: null, sleeveRightImage: null });
  };
  const pickSavedColor = (c) => setColorDraft((d) => ({ ...d, name: c.name, hex: c.hex }));
  const addRolyToQueue = () => {
    if (!rolyInput.trim()) return;
    const { found, notFound } = lookupRolyColorsByNumbers(rolyInput);
    setRolyQueue((q) => {
      const already = new Set(q.map((c) => c.name));
      return [...q, ...found.filter((c) => !already.has(c.name))];
    });
    setRolyNotFound(notFound);
    setRolyInput("");
  };
  const useQueuedRolyColor = (i) => {
    const c = rolyQueue[i];
    if (!c) return;
    pickSavedColor(c);
    setRolyQueue((q) => q.filter((_, idx) => idx !== i));
  };
  const editColor = (i) => { setColorDraft(draft.colors[i]); setEditingColorIdx(i); setColorError(""); };
  const removeColor = (i) => {
    setDraft((d) => ({ ...d, colors: d.colors.filter((_, idx) => idx !== i) }));
    if (editingColorIdx === i) { setEditingColorIdx(null); setColorDraft({ name: "", hex: "#E8452C", images: [], frontImage: null, backImage: null, sleeveLeftImage: null, sleeveRightImage: null }); }
  };

  const addDesign = () => {
    if (!designDraft.name) return;
    if (editingDesignIdx !== null) {
      setDraft((d) => ({ ...d, designs: d.designs.map((x, idx) => (idx === editingDesignIdx ? designDraft : x)) }));
      setEditingDesignIdx(null);
    } else {
      setDraft((d) => ({ ...d, designs: [...d.designs, designDraft] }));
    }
    setDesignDraft({ name: "", image: "" });
  };
  const editDesign = (i) => { setDesignDraft(draft.designs[i]); setEditingDesignIdx(i); };
  const removeDesign = (i) => {
    setDraft((d) => ({ ...d, designs: d.designs.filter((_, idx) => idx !== i) }));
    if (editingDesignIdx === i) { setEditingDesignIdx(null); setDesignDraft({ name: "", image: "" }); }
  };

  // Arma el objeto de producto final a partir del draft actual — lo usa tanto
  // "Guardar" como "Duplicar en otras categorías" (ver más abajo), pasando
  // overrides (id/categoría/designGroup/sku nuevos) para cada copia.
  const buildProductObject = (overrides = {}) => {
    const hasSalePrice = !!(draft.salePrice && Number(draft.salePrice) > 0);
    return {
      ...draft,
      id: draft.id || genId("p"),
      price: Number(draft.price),
      salePrice: hasSalePrice ? Number(draft.salePrice) : null,
      tags: { ...draft.tags, oferta: hasSalePrice },
      stock: Number(draft.stock) || 0,
      // Vacío = usa el puntaje general de Ajustes → Fidelización para esta
      // prenda; un número acá lo pisa (ver handleCheckout, que suma esto por
      // cada prenda del pedido en vez de una sola cifra fija para todo).
      points: draft.points === "" || draft.points === null || draft.points === undefined ? null : Number(draft.points) || 0,
      // Código corto de referencia (ej: "BEAGLE-001") en vez del id interno —
      // se genera solo a partir del nombre si el admin no cargó uno propio.
      sku: draft.sku.trim() || generateSku(draft.name, allProducts.filter((p) => p.id !== draft.id)),
      createdAt: draft.createdAt || Date.now(),
      salesCount: draft.salesCount || 0,
      viewsCount: draft.viewsCount || 0,
      designGroup: (draft.designGroup || "").trim(),
      ...overrides,
    };
  };

  const handleSave = async () => {
    if (!draft.name || !draft.category || !draft.price) return;
    setSaving(true);
    const product = buildProductObject();
    await onSave(product);
    setSaving(false);
    setDraft({ ...emptyDraft, tags: { ...emptyDraft.tags, template: defaultTemplate } });
    setStep(1);
  };

  // Duplicar en otras categorías: para no tener que subir 1000 diseños 3
  // veces cada uno cuando la misma foto sirve para varias prendas (ej: la
  // misma estampa en Oversize, Remera normal y Buzo) — reusa las mismas
  // fotos/colores/talles del producto actual, crea una copia por cada
  // categoría elegida, y las vincula todas con "Vincular con otro estilo"
  // (designGroup) para que en la ficha se vea "también disponible en".
  const [dupCats, setDupCats] = useState([]);
  const [duplicating, setDuplicating] = useState(false);
  const [dupDone, setDupDone] = useState(0);
  const toggleDupCat = (cat) => setDupCats((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));

  const handleDuplicateToCategories = async () => {
    if (!draft.name || !draft.category || !draft.price || dupCats.length === 0) return;
    setDuplicating(true);
    setDupDone(0);
    // Si el producto original no tenía un texto en "Vincular con otro
    // estilo", le generamos uno (con el nombre, para reconocerlo fácil en la
    // lista) y se lo aplicamos también al original — sin esto, las copias
    // quedarían vinculadas entre sí pero NO con el producto original.
    const group = (draft.designGroup || "").trim() || `${draft.name.trim()} (${genId("dg").slice(-5)})`;
    const original = buildProductObject({ designGroup: group });
    await onSave(original);
    setDraft((d) => ({ ...d, id: original.id, designGroup: group }));
    // Cada copia necesita su propio código (sku) — vamos sumando las que ya
    // creamos en esta misma tanda a la lista de "usados", porque todas
    // comparten el mismo nombre y si no, generateSku les daría el mismo código.
    let knownProducts = allProducts;
    let count = 0;
    for (const cat of dupCats) {
      const copy = buildProductObject({
        id: genId("p"),
        category: cat,
        designGroup: group,
        sku: "",
        // Que un diseño esté disponible en otra prenda no significa que
        // también sea "más vendido", "oferta" o "tendencia" — cada modelo
        // arranca sin esas etiquetas, aunque el original ya las tuviera.
        tags: { ...draft.tags, bestseller: false, oferta: false, tendencia: false },
      });
      copy.sku = generateSku(copy.name, knownProducts);
      knownProducts = [...knownProducts, copy];
      await onSave(copy);
      count += 1;
      setDupDone(count);
    }
    setDuplicating(false);
    setDupCats([]);
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };
  const step1Ready = draft.name.trim() && draft.category && String(draft.price).trim();
  // Sugerencias para "vincular con otro estilo": todos los textos ya usados
  // en otros productos, así el admin puede reusar exactamente el mismo en
  // vez de tener que escribirlo igual a mano cada vez.
  const designGroupSuggestions = Array.from(new Set(allProducts.map((p) => p.designGroup).filter(Boolean)));

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>{draft.id ? "Editar producto" : "Nuevo producto"}</h4>

      {isNew && (
        <div className="flex items-center gap-1.5 mb-1 flex-wrap">
          {[
            { n: 1, label: "Datos y fotos" },
            { n: 2, label: "Etiquetas y talles" },
            { n: 3, label: "Fotos por color" },
            { n: 4, label: "Diseños y publicar" },
          ].map((s, i, arr) => (
            <div key={s.n} className="flex items-center gap-1.5">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
                style={{ background: step >= s.n ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
              >
                {s.n}
              </div>
              <span className="text-xs" style={{ color: step >= s.n ? "var(--bone)" : "var(--slate)" }}>{s.label}</span>
              {i < arr.length - 1 && <div className="w-4 h-px" style={{ background: "var(--line)" }} />}
            </div>
          ))}
        </div>
      )}

      {showStep(1) && (
      <>
      {/* Photos — first and prominent, like listing an item on a marketplace app */}
      <div>
        <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Fotos</p>
        <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>La primera es la portada. Usá las flechas para ordenarlas, o la estrella para poner una de portada.</p>
        {draft.photoPool.length > 0 ? (
          <div className="flex flex-wrap gap-2 mb-2">
            {draft.photoPool.map((img, i) => (
              <div key={i} className="relative w-24 h-24 rounded-xl overflow-hidden" style={{ background: "var(--ink-3)", border: i === 0 ? "2px solid var(--sun)" : "1px solid var(--line)" }}>
                <img loading="lazy" src={img} className="w-full h-full object-contain" alt="" />
                <button
                  onClick={() => recropPoolImage(img)}
                  className="kulto-btn absolute top-0.5 left-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(21,19,26,0.8)", color: "var(--bone)" }}
                  title="Recortar de nuevo"
                >
                  <Pencil size={10} />
                </button>
                <button
                  onClick={() => removeFromPool(img)}
                  className="kulto-btn absolute top-0.5 right-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(21,19,26,0.8)", color: "var(--bone)" }}
                  title="Quitar"
                >
                  <X size={11} />
                </button>
                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-1 py-0.5" style={{ background: "rgba(21,19,26,0.8)" }}>
                  <button
                    onClick={() => movePoolImage(i, -1)}
                    disabled={i === 0}
                    className="kulto-btn w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ color: i === 0 ? "rgba(243,239,230,0.25)" : "var(--bone)" }}
                    title="Mover a la izquierda"
                  >
                    <ChevronLeft size={13} />
                  </button>
                  {i === 0 ? (
                    <span className="text-[9px] font-semibold" style={{ color: "var(--sun)" }}>Portada</span>
                  ) : (
                    <button onClick={() => makeCoverImage(i)} className="kulto-btn w-5 h-5 rounded-full flex items-center justify-center" style={{ color: "var(--sun)" }} title="Poner de portada">
                      <Star size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => movePoolImage(i, 1)}
                    disabled={i === draft.photoPool.length - 1}
                    className="kulto-btn w-5 h-5 rounded-full flex items-center justify-center"
                    style={{ color: i === draft.photoPool.length - 1 ? "rgba(243,239,230,0.25)" : "var(--bone)" }}
                    title="Mover a la derecha"
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
              </div>
            ))}
            <label
              className="kulto-btn w-20 h-20 rounded-xl flex flex-col items-center justify-center gap-1"
              style={{ background: "var(--ink-3)", border: "1px dashed var(--line)", color: "var(--slate)" }}
            >
              <Upload size={18} />
              <span className="text-[10px]">Agregar</span>
              <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files.length) addPhotosToPool(e.target.files); e.target.value = ""; }} />
            </label>
          </div>
        ) : (
          <label
            className="kulto-btn w-full rounded-xl flex flex-col items-center justify-center gap-2 py-8"
            style={{ background: "var(--ink-3)", border: "1px dashed var(--line)", color: "var(--slate)" }}
          >
            <Upload size={24} />
            <span className="text-sm">Tocá para subir las fotos de esta prenda</span>
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files.length) addPhotosToPool(e.target.files); e.target.value = ""; }} />
          </label>
        )}
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Se ven así, tal cual, en la web — sin pasos extra. La primera foto es la que aparece de portada.
        </p>
      </div>

      {/* AI autofill */}
      {draft.photoPool.length > 0 && (
        <div>
          <button
            onClick={handleAiFill}
            disabled={aiLoading}
            className="kulto-btn w-full rounded-xl py-3 font-semibold flex items-center justify-center gap-2"
            style={{ background: "var(--ink-3)", color: "var(--sun)", border: "1px solid var(--line)" }}
          >
            {aiLoading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {aiLoading ? "Analizando la foto..." : "Rellenar nombre, categoría y descripción con IA"}
          </button>
          {aiError && <p className="text-xs mt-1" style={{ color: "var(--signal)" }}>{aiError}</p>}
        </div>
      )}

      <input placeholder="Nombre del producto" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="rounded-xl p-3 text-sm" style={inputStyle} />

      <textarea
        placeholder="Descripción breve (opcional)"
        value={draft.description}
        onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        rows={2}
        className="rounded-xl p-3 text-sm"
        style={inputStyle}
      />

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--slate)" }}>Grupo / temática (opcional — ej: Anime, Diseños Kulto, Música)</label>
        <div className="flex gap-2">
          <select value={draft.group} onChange={(e) => setDraft({ ...draft, group: e.target.value })} className="flex-1 rounded-xl p-3 text-sm" style={inputStyle}>
            <option value="">Sin grupo</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <div className="flex gap-2 mt-2">
          <input placeholder="Nuevo grupo" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} className="flex-1 rounded-xl p-3 text-sm" style={inputStyle} />
          <button
            className="kulto-btn rounded-xl px-4 text-sm font-semibold"
            style={{ background: "var(--ink-3)", color: "var(--bone)" }}
            onClick={() => { if (newGroup.trim()) { onAddGroup(newGroup.trim()); setDraft({ ...draft, group: newGroup.trim() }); setNewGroup(""); } }}
          >
            Añadir
          </button>
        </div>
      </div>

      <div className="flex gap-2">
        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="flex-1 rounded-xl p-3 text-sm" style={inputStyle}>
          <option value="">Selecciona categoría</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="flex gap-2">
        <input placeholder="Nueva categoría" value={newCat} onChange={(e) => setNewCat(e.target.value)} className="flex-1 rounded-xl p-3 text-sm" style={inputStyle} />
        <button
          className="kulto-btn rounded-xl px-4 text-sm font-semibold"
          style={{ background: "var(--ink-3)", color: "var(--bone)" }}
          onClick={() => { if (newCat.trim()) { onAddCategory(newCat.trim()); setDraft({ ...draft, category: newCat.trim() }); setNewCat(""); } }}
        >
          Añadir
        </button>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--slate)" }}>Vincular con otro estilo del mismo diseño (opcional)</label>
        <input
          list="design-group-options"
          placeholder='Ej: "Dragón Ancestral" — poné el mismo texto en cada estilo (Beagle, Oversize, etc.)'
          value={draft.designGroup}
          onChange={(e) => setDraft({ ...draft, designGroup: e.target.value })}
          className="w-full rounded-xl p-3 text-sm"
          style={inputStyle}
        />
        <datalist id="design-group-options">
          {designGroupSuggestions.map((g) => <option key={g} value={g} />)}
        </datalist>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Si vendés el mismo diseño en varias prendas a distinto precio, escribí el mismo texto acá en cada una — el cliente va a ver un botón para pasar de un estilo al otro sin perder el diseño que le gustó.
        </p>
      </div>

      {categories.filter((c) => c !== draft.category).length > 0 && (
        <div className="rounded-2xl p-3" style={{ background: "var(--ink-3)", border: "1px dashed var(--line)" }}>
          <label className="text-xs mb-1 block font-semibold" style={{ color: "var(--bone)" }}>Duplicar este diseño en otras categorías (opcional)</label>
          <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
            Para no tener que subir la misma foto varias veces: elegí en qué otras categorías también se vende este mismo diseño (ej: Oversize, Remera normal, Buzo) y se crea una copia en cada una, con las mismas fotos y colores, ya vinculadas entre sí.
          </p>
          <div className="flex flex-wrap gap-2 mb-2">
            {categories.filter((c) => c !== draft.category).map((c) => (
              <label
                key={c}
                className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1.5 cursor-pointer"
                style={{ background: dupCats.includes(c) ? "var(--signal)" : "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
              >
                <input type="checkbox" checked={dupCats.includes(c)} onChange={() => toggleDupCat(c)} className="hidden" />
                {c}
              </label>
            ))}
          </div>
          <button
            type="button"
            disabled={dupCats.length === 0 || duplicating || !draft.name || !draft.category || !draft.price}
            onClick={handleDuplicateToCategories}
            className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-2"
            style={{ background: dupCats.length === 0 ? "var(--ink)" : "var(--sun)", color: dupCats.length === 0 ? "var(--slate)" : "var(--ink)", opacity: duplicating ? 0.7 : 1 }}
          >
            {duplicating ? <Loader2 size={16} className="animate-spin" /> : <Boxes size={16} />}
            {duplicating ? `Creando… (${dupDone}/${dupCats.length})` : `Duplicar en ${dupCats.length || ""} categoría${dupCats.length === 1 ? "" : "s"}`.trim()}
          </button>
          {!draft.name || !draft.category || !draft.price ? (
            <p className="text-xs mt-1" style={{ color: "var(--signal)" }}>Completá nombre, categoría y precio arriba antes de duplicar.</p>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <input type="number" placeholder="Precio (€)" value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} className="rounded-xl p-3 text-sm" style={inputStyle} />
        <input type="number" placeholder="Stock" value={draft.stock} onChange={(e) => setDraft({ ...draft, stock: e.target.value })} className="rounded-xl p-3 text-sm" style={inputStyle} />
      </div>
      <div>
        <input type="number" min="0" placeholder="Puntos de fidelización (vacío = usar el general)" value={draft.points} onChange={(e) => setDraft({ ...draft, points: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Cuántos puntos suma comprar esta prenda (por unidad). Dejalo vacío para usar el puntaje general de Ajustes → Fidelización.
        </p>
      </div>
      <div>
        <input type="text" placeholder="Código de referencia (vacío = se genera solo, ej: BEAGLE-001)" value={draft.sku} onChange={(e) => setDraft({ ...draft, sku: e.target.value.toUpperCase() })} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Se usa como referencia corta en vez de un código largo — aparece en el mensaje de WhatsApp del pedido. Dejalo vacío para que se arme solo con el nombre de la prenda.
        </p>
      </div>

      {isNew && (
        <div className="flex justify-end">
          <button
            disabled={!step1Ready}
            onClick={() => setStep(2)}
            className="kulto-btn text-sm font-semibold px-5 py-2.5 rounded-full flex items-center gap-1"
            style={{ background: step1Ready ? "var(--signal)" : "var(--ink-3)", color: step1Ready ? "var(--bone)" : "var(--slate)", cursor: step1Ready ? "pointer" : "default" }}
          >
            Continuar <ChevronRight size={16} />
          </button>
        </div>
      )}
      </>
      )}

      {!isNew && (
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="kulto-btn text-sm font-semibold flex items-center gap-1 py-1"
        style={{ color: "var(--sun)" }}
      >
        {showAdvanced ? "Ocultar" : "Mostrar"} opciones avanzadas (talles, colores, etiquetas, diseños)
        <ChevronRight size={15} style={{ transform: showAdvanced ? "rotate(90deg)" : "none", transition: "transform .15s" }} />
      </button>
      )}

      {(showAdvanced || (isNew && step >= 2)) && (
        <div className="flex flex-col gap-4 pt-2" style={{ borderTop: "1px solid var(--line)" }}>
          {showStep(2) && (
          <>
          <div className="flex flex-wrap gap-4 text-sm" style={{ color: "var(--bone)" }}>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.tags.bestseller} onChange={(e) => setDraft({ ...draft, tags: { ...draft.tags, bestseller: e.target.checked } })} /> Más vendido
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.tags.tendencia} onChange={(e) => setDraft({ ...draft, tags: { ...draft.tags, tendencia: e.target.checked } })} /> Tendencia
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--bone)" }}>
            <input type="checkbox" checked={draft.tags.template} onChange={(e) => setDraft({ ...draft, tags: { ...draft.tags, template: e.target.checked } })} />
            Solo para personalizar — no aparece en el catálogo, solo como estilo de prenda al armar un pedido personalizado
          </label>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--slate)" }}>
              Precio de oferta (opcional) — si cargás uno, esta prenda pasa automáticamente a la sección "En oferta" de la web, con el precio tachado y el nuevo precio al lado. Dejalo vacío para venderla al precio normal.
            </label>
            <input
              type="number"
              placeholder="Ej: 15.99"
              value={draft.salePrice}
              onChange={(e) => {
                const val = e.target.value;
                setDraft({ ...draft, salePrice: val, tags: { ...draft.tags, oferta: !!val.trim() } });
              }}
              className="rounded-xl p-3 text-sm w-full"
              style={inputStyle}
            />
          </div>

          {/* Sizes */}
          <div>
            <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Talles que maneja esta prenda</p>
            <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>Dejalo vacío si el producto no usa talles (ej. llaveros).</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {SIZE_PRESETS.map((s) => {
                const active = draft.sizes.includes(s);
                return (
                  <button
                    key={s}
                    onClick={() => setDraft((d) => ({ ...d, sizes: active ? d.sizes.filter((x) => x !== s) : [...d.sizes, s] }))}
                    className="kulto-btn text-sm font-semibold rounded-full px-3 py-1.5"
                    style={{ background: active ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)", border: active ? "1px solid var(--signal)" : "1px solid var(--line)" }}
                  >
                    {s}
                  </button>
                );
              })}
            </div>
            {draft.sizes.filter((s) => !SIZE_PRESETS.includes(s)).length > 0 && (
              <div className="flex flex-wrap gap-2 mb-2">
                {draft.sizes.filter((s) => !SIZE_PRESETS.includes(s)).map((s) => (
                  <div key={s} className="flex items-center gap-1 rounded-full pl-3 pr-2 py-1" style={{ background: "var(--ink-3)" }}>
                    <span className="text-xs" style={{ color: "var(--bone)" }}>{s}</span>
                    <button onClick={() => setDraft((d) => ({ ...d, sizes: d.sizes.filter((x) => x !== s) }))} style={{ color: "var(--slate)" }}><X size={12} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                placeholder="Otro talle (ej. Único, 6-8 años)"
                value={customSize}
                onChange={(e) => setCustomSize(e.target.value)}
                className="rounded-xl p-2 text-sm flex-1"
                style={inputStyle}
              />
              <button
                onClick={() => { const v = customSize.trim(); if (v && !draft.sizes.includes(v)) { setDraft((d) => ({ ...d, sizes: [...d.sizes, v] })); } setCustomSize(""); }}
                className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2"
                style={{ background: "var(--sun)", color: "var(--ink)" }}
              >
                Agregar
              </button>
            </div>
          </div>

          {/* Size guide */}
          {draft.sizes.length > 0 && (
            <div>
              <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Guía de talles (opcional)</p>
              <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>Medidas por talle — el cliente la ve antes de elegir. Dejalo vacío si no querés mostrar guía en esta prenda.</p>
              {draft.sizes.map((s) => {
                const row = draft.sizeGuide?.find((g) => g.size === s);
                return (
                  <div key={s} className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-semibold w-14 shrink-0" style={{ color: "var(--bone)" }}>{s}</span>
                    <input
                      placeholder="Ej: Pecho 96cm · Largo 70cm"
                      value={row?.measurements || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDraft((d) => {
                          const rest = (d.sizeGuide || []).filter((g) => g.size !== s);
                          const next = val.trim() ? [...rest, { size: s, measurements: val }] : rest;
                          return { ...d, sizeGuide: next };
                        });
                      }}
                      className="rounded-xl p-2 text-sm flex-1"
                      style={inputStyle}
                    />
                  </div>
                );
              })}
              <div className="mt-3">
                <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
                  ¿Preferís mostrar una foto con las medidas (por ejemplo, la tabla de talles del fabricante) en vez de escribirlas a mano? Subila acá — se muestra junto con (o en lugar de) la tabla de arriba.
                </p>
                <div className="flex items-center gap-3">
                  {draft.sizeGuideImage && (
                    <img src={draft.sizeGuideImage} alt="Guía de talles" className="w-20 h-20 object-cover rounded-xl" style={{ border: "1px solid var(--line)" }} />
                  )}
                  <label className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2 cursor-pointer" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}>
                    {draft.sizeGuideImage ? "Cambiar imagen" : "Subir imagen"}
                    <input
                      type="file" accept="image/png, image/jpeg" className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const isPng = f.type === "image/png";
                        fileToBase64(f, (b64) => setDraft((d) => ({ ...d, sizeGuideImage: b64 })), 1200, isPng ? 1 : 0.88, isPng ? "image/png" : "image/jpeg");
                      }}
                    />
                  </label>
                  {draft.sizeGuideImage && (
                    <button onClick={() => setDraft((d) => ({ ...d, sizeGuideImage: null }))} className="kulto-btn text-xs" style={{ color: "var(--signal)" }}>Quitar</button>
                  )}
                </div>
              </div>
            </div>
          )}

          {isNew && (
            <div className="flex justify-between">
              <button onClick={() => setStep(1)} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-1" style={{ border: "1px solid var(--line)", color: "var(--slate)" }}>
                <ChevronLeft size={16} /> Atrás
              </button>
              <button onClick={() => setStep(3)} className="kulto-btn text-sm font-semibold px-5 py-2.5 rounded-full flex items-center gap-1" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                Continuar <ChevronRight size={16} />
              </button>
            </div>
          )}
          </>
          )}

          {showStep(3) && (
          <>
          {/* Photo display */}
          <div>
            <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Cómo se ven las fotos</p>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setDraft((d) => ({ ...d, imageFit: "contain" }))}
                className="kulto-btn flex-1 text-xs font-semibold px-3 py-2 rounded-full"
                style={{ background: draft.imageFit !== "cover" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
              >
                Ajustar (se ve completa)
              </button>
              <button
                onClick={() => setDraft((d) => ({ ...d, imageFit: "cover" }))}
                className="kulto-btn flex-1 text-xs font-semibold px-3 py-2 rounded-full"
                style={{ background: draft.imageFit === "cover" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
              >
                Llenar el marco (recorta un poco)
              </button>
            </div>
            {draft.imageFit !== "cover" && (
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs" style={{ color: "var(--bone)" }}>
                  <input
                    type="checkbox"
                    checked={draft.imageBackground !== null}
                    onChange={(e) => setDraft((d) => ({ ...d, imageBackground: e.target.checked ? "#FFFFFF" : null }))}
                  />
                  Elegir un color de fondo para el espacio que sobra
                </label>
                {draft.imageBackground !== null && (
                  <input
                    type="color"
                    value={draft.imageBackground}
                    onChange={(e) => setDraft((d) => ({ ...d, imageBackground: e.target.value }))}
                    className="w-9 h-9 rounded"
                    style={{ background: "transparent" }}
                  />
                )}
              </div>
            )}
            <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
              {draft.imageBackground === null
                ? "Por defecto, el espacio alrededor de la foto usa el color de la prenda."
                : "Ese color se usa detrás de la foto en vez del color de la prenda."}
            </p>
          </div>

          {/* Colors */}
          <div>
            <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Colores (opcional)</p>
            <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
              Si no agregás colores, la web muestra directamente todas las fotos de arriba. Agregá colores solo si querés que, al elegir uno, cambien las fotos que se ven.
            </p>
            <div className="flex flex-wrap gap-2 mb-2">
              {draft.colors.map((c, i) => (
                <div
                  key={i}
                  onClick={() => editColor(i)}
                  className="kulto-btn flex items-center gap-1 rounded-full pl-1 pr-2 py-1"
                  style={{ background: editingColorIdx === i ? "var(--signal)" : "var(--ink-3)" }}
                >
                  <span className="w-5 h-5 rounded-full overflow-hidden" style={{ background: c.hex }}>{c.images && c.images[0] && <img loading="lazy" src={c.images[0]} className="w-full h-full object-cover" alt={c.name || "Color"} />}</span>
                  <span className="text-xs" style={{ color: "var(--bone)" }}>{c.name}</span>
                  {c.images && c.images.length > 1 && <span className="text-[10px]" style={{ color: "var(--bone)", opacity: 0.7 }}>+{c.images.length - 1}</span>}
                  <button onClick={(e) => { e.stopPropagation(); removeColor(i); }} style={{ color: "var(--bone)" }} aria-label="Quitar color"><X size={12} /></button>
                </div>
              ))}
            </div>
            {draft.colors.length > 0 && <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>Toca un color de la lista para editarlo.</p>}

            {savedColors && savedColors.length > 0 && (
              <div className="mb-3">
                <p className="text-xs mb-1" style={{ color: "var(--slate)" }}>Colores guardados — tocá uno para reusarlo:</p>
                <div className="flex flex-wrap gap-2">
                  {savedColors.map((c, i) => (
                    <div
                      key={i}
                      onClick={() => pickSavedColor(c)}
                      className="kulto-btn flex items-center gap-1.5 rounded-full pl-1 pr-2 py-1"
                      style={{ background: "var(--ink-3)", border: colorDraft.name === c.name && colorDraft.hex === c.hex ? "1px solid var(--sun)" : "1px solid var(--line)" }}
                    >
                      <span className="w-4 h-4 rounded-full" style={{ background: c.hex }} />
                      <span className="text-xs" style={{ color: "var(--bone)" }}>{c.name}</span>
                      <button onClick={(e) => { e.stopPropagation(); onRemoveColorFromLibrary?.(c); }} style={{ color: "var(--slate)" }} title="Quitar de la librería">
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-3 rounded-xl p-3" style={{ background: "var(--ink-3)", border: "1px dashed var(--line)" }}>
              <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
                Agregar por número de Roly: escribí todos los números de esta prenda de una (ej: "01, 47, 56, 777") y quedan esperando acá para que les subas la foto uno por uno.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  placeholder="ej: 01, 47, 56, 777"
                  value={rolyInput}
                  onChange={(e) => setRolyInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRolyToQueue(); } }}
                  className="rounded-xl p-2 text-sm flex-1 min-w-[160px]"
                  style={inputStyle}
                />
                <button type="button" onClick={addRolyToQueue} className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                  Agregar a la cola
                </button>
              </div>
              {rolyNotFound.length > 0 && (
                <p className="text-xs mt-2" style={{ color: "var(--signal)" }}>
                  No encontré en el catálogo: {rolyNotFound.join(", ")}.
                </p>
              )}
              {rolyQueue.length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">
                  {rolyQueue.map((c, i) => (
                    <button
                      type="button"
                      key={c.name + i}
                      onClick={() => useQueuedRolyColor(i)}
                      className="kulto-btn flex items-center gap-1.5 rounded-full pl-1 pr-2 py-1"
                      style={{ background: "var(--ink)", border: "1px solid var(--line)" }}
                      title="Usar este color ahora"
                    >
                      <span className="w-4 h-4 rounded-full" style={{ background: c.hex }} />
                      <span className="text-xs" style={{ color: "var(--bone)" }}>{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
              {rolyQueue.length > 0 && (
                <p className="text-xs mt-2" style={{ color: "var(--slate)" }}>Tocá uno para cargarlo abajo y subirle la foto.</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 mb-2">
              <input placeholder="Nombre o número (opcional)" value={colorDraft.name} onChange={(e) => setColorDraft({ ...colorDraft, name: e.target.value })} className="rounded-xl p-2 text-sm w-32" style={inputStyle} />
              <input type="color" value={colorDraft.hex} onChange={(e) => setColorDraft({ ...colorDraft, hex: e.target.value })} className="w-10 h-9 rounded" style={{ background: "transparent" }} />
            </div>
            <div className="mb-2">
              <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
                Subí una foto para cada parte de la prenda en este color (adelante, atrás, mangas). Ninguna es obligatoria en particular, pero necesitás al menos una para que el color funcione en Personalizar.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {ZONE_UPLOAD_DEFS.map((zdef) => {
                  const img = colorDraft[zdef.key];
                  return (
                    <div key={zdef.key} className="flex flex-col items-center gap-1">
                      <label
                        className="kulto-btn relative w-full rounded-xl overflow-hidden flex items-center justify-center cursor-pointer"
                        style={{ aspectRatio: "4 / 5", background: "var(--ink-3)", border: img ? "2px solid var(--sun)" : "1px dashed var(--line)" }}
                      >
                        {img ? (
                          <img loading="lazy" src={img} className="w-full h-full object-contain" alt={zdef.label} />
                        ) : (
                          <span className="flex flex-col items-center gap-1 px-1 text-center">
                            <Upload size={18} style={{ color: "var(--slate)" }} />
                            <span className="text-[10px]" style={{ color: "var(--slate)" }}>Subir foto</span>
                          </span>
                        )}
                        <input
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => { const f = e.target.files[0]; if (f) handleZoneUpload(zdef.key, f); e.target.value = ""; }}
                        />
                      </label>
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] font-semibold" style={{ color: img ? "var(--sun)" : "var(--slate)" }}>
                          {zdef.label}
                        </span>
                        {img && (
                          <button type="button" onClick={() => removeZoneImage(zdef.key)} className="kulto-btn" style={{ color: "var(--slate)" }} title="Quitar foto">
                            <X size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              {!colorHasAnyZoneImage(colorDraft) && (
                <p className="text-xs mt-2" style={{ color: "var(--signal)" }}>
                  Falta subir al menos una foto — sin ninguna, el cliente no puede personalizar este color.
                </p>
              )}
            </div>
            {colorError && (
              <p className="text-xs mb-2" style={{ color: "var(--signal)" }}>{colorError}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={addColor} className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2" style={{ background: "var(--sun)", color: "var(--ink)" }}>
                {editingColorIdx !== null ? "Guardar color" : "Agregar color"}
              </button>
              {editingColorIdx !== null && (
                <button onClick={() => { setEditingColorIdx(null); setColorDraft({ name: "", hex: "#E8452C", images: [], frontImage: null, backImage: null, sleeveLeftImage: null, sleeveRightImage: null }); }} className="kulto-btn text-xs px-3 py-2" style={{ color: "var(--slate)" }}>
                  Cancelar
                </button>
              )}
            </div>
          </div>

          {isNew && (
            <div className="flex justify-between">
              <button onClick={() => setStep(2)} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-1" style={{ border: "1px solid var(--line)", color: "var(--slate)" }}>
                <ChevronLeft size={16} /> Atrás
              </button>
              <button onClick={() => setStep(4)} className="kulto-btn text-sm font-semibold px-5 py-2.5 rounded-full flex items-center gap-1" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                Continuar <ChevronRight size={16} />
              </button>
            </div>
          )}
          </>
          )}

          {showStep(4) && (
          <>
          {/* Designs */}
          <div>
            <label className="flex items-center gap-2 text-sm mb-3" style={{ color: "var(--bone)" }}>
              <input
                type="checkbox"
                checked={draft.tags.customDesign === true}
                onChange={(e) => setDraft({ ...draft, tags: { ...draft.tags, customDesign: e.target.checked } })}
              />
              Permitir que el cliente suba su propio diseño en esta prenda
            </label>
            <p className="text-xs mb-3" style={{ color: "var(--slate)" }}>
              Si no tildás esto ni cargás diseños abajo, el producto se vende tal cual está en la foto — no le va a aparecer al cliente el paso de "elegí tu diseño".
            </p>
            <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Diseños propios para sublimar (opcional)</p>
            <div className="flex flex-wrap gap-2 mb-2">
              {draft.designs.map((d, i) => (
                <div
                  key={i}
                  onClick={() => editDesign(i)}
                  className="kulto-btn flex items-center gap-1 rounded-full pl-1 pr-2 py-1"
                  style={{ background: editingDesignIdx === i ? "var(--signal)" : "var(--ink-3)" }}
                >
                  <span className="w-5 h-5 rounded-full overflow-hidden bg-white/10">{d.image && <img loading="lazy" src={d.image} className="w-full h-full object-contain" alt={d.name || "Diseño"} />}</span>
                  <span className="text-xs" style={{ color: "var(--bone)" }}>{d.name}</span>
                  <button onClick={(e) => { e.stopPropagation(); removeDesign(i); }} style={{ color: "var(--bone)" }} aria-label="Quitar diseño"><X size={12} /></button>
                </div>
              ))}
            </div>
            <p className="text-xs mb-1" style={{ color: "var(--slate)" }}>Toca un diseño de la lista para editarlo.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input placeholder="Nombre del diseño" value={designDraft.name} onChange={(e) => setDesignDraft({ ...designDraft, name: e.target.value })} className="rounded-xl p-2 text-sm w-40" style={inputStyle} />
              <label className="kulto-btn text-xs flex items-center gap-1 rounded-xl px-3 py-2" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                <Upload size={14} /> Imagen
                <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files[0]; if (f) { const isPng = f.type === "image/png"; fileToBase64(f, (b64) => setDesignDraft((d) => ({ ...d, image: b64 })), 1000, isPng ? 1 : 0.85, isPng ? "image/png" : "image/jpeg"); } }} />
              </label>
              <button onClick={addDesign} className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2" style={{ background: "var(--sun)", color: "var(--ink)" }}>
                {editingDesignIdx !== null ? "Guardar diseño" : "Agregar diseño"}
              </button>
              {editingDesignIdx !== null && (
                <button onClick={() => { setEditingDesignIdx(null); setDesignDraft({ name: "", image: "" }); }} className="kulto-btn text-xs px-3 py-2" style={{ color: "var(--slate)" }}>
                  Cancelar
                </button>
              )}
            </div>
          </div>

          {isNew && (
            <div className="flex justify-start">
              <button onClick={() => setStep(3)} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-1" style={{ border: "1px solid var(--line)", color: "var(--slate)" }}>
                <ChevronLeft size={16} /> Atrás
              </button>
            </div>
          )}
          </>
          )}
        </div>
      )}

      {showStep(4) && (
      <div className="flex gap-2 mt-2">
        <button disabled={saving} onClick={handleSave} className="kulto-btn flex-1 rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: "var(--signal)", color: "var(--bone)" }}>
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {draft.id ? "Guardar cambios" : "Publicar producto"}
        </button>
        {draft.id && (
          <button onClick={() => { setDraft({ ...emptyDraft, tags: { ...emptyDraft.tags, template: defaultTemplate } }); setStep(1); onCancelEdit(); }} className="kulto-btn rounded-full px-5" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            Cancelar
          </button>
        )}
      </div>
      )}

      {cropSource && (
        <CropModal source={cropSource} onConfirm={handleCropConfirm} onCancel={handleCropCancel} />
      )}
    </div>
  );
}

// Las 4 fotos que puede tener una prenda para "Personalizar": frontal siempre,
// las otras tres solo si el admin las carga.
const TEMPLATE_ZONE_DEFS = [
  { key: "frontImage", label: "Frontal" },
  { key: "backImage", label: "Espalda" },
  { key: "sleeveLeftImage", label: "Manga izquierda" },
  { key: "sleeveRightImage", label: "Manga derecha" },
];

// Para quién es la prenda — algunos proveedores tienen el mismo modelo en
// talles/cortes de hombre, mujer o niños, y otros (como las oversize, por
// sueltas) sirven para cualquiera. "unisex" es el valor por defecto, así las
// prendas ya cargadas antes de este campo siguen apareciendo para todos.
const AUDIENCE_LABELS = { unisex: "Unisex", hombre: "Hombre", mujer: "Mujer", kids: "Niños" };
const AUDIENCE_OPTIONS = ["unisex", "hombre", "mujer", "kids"];

const emptyTemplateDraft = {
  id: null,
  name: "",
  description: "",
  category: "",
  subcategory: "",
  audience: "unisex",
  price: "",
  points: "",
  sku: "",
  sizes: [],
  sizeGuide: [],
  sizeGuideImage: null,
  colors: [],
};

const emptyTemplateColorDraft = { name: "", hex: "#E8452C", frontImage: null, backImage: null, sleeveLeftImage: null, sleeveRightImage: null };

// Formulario simplificado, solo para "Personalizar": una prenda acá es un
// tipo de prenda (ej: "Camisetas", "Sudaderas con capucha") con TODOS los
// colores en los que la tenés — el cliente los ve juntos, estilo selección de
// personaje, antes de subir su diseño. No lleva stock porque se hace bajo
// pedido, y cada color solo pide sus 4 fotos con nombre de zona (Frontal /
// Espalda / Manga izquierda / Manga derecha) — nada del formulario largo de
// "Productos" (que además maneja ofertas, fotos genéricas, etc.).
function AdminTemplateForm({ categories, templateProducts = [], onAddCategory, onSave, editing, onCancelEdit }) {
  const [draft, setDraft] = useState(emptyTemplateDraft);
  const [newCat, setNewCat] = useState("");
  const [customSize, setCustomSize] = useState("");
  const [saving, setSaving] = useState(false);
  const [colorDraft, setColorDraft] = useState(emptyTemplateColorDraft);
  const [editingColorIdx, setEditingColorIdx] = useState(null);
  const [colorError, setColorError] = useState("");
  // Cola de colores de Roly cargados por número, esperando su foto — ver
  // "Agregar por número de Roly" más abajo.
  const [rolyInput, setRolyInput] = useState("");
  const [rolyQueue, setRolyQueue] = useState([]);
  const [rolyNotFound, setRolyNotFound] = useState([]);

  // Subgrupos ya usados dentro de la categoría elegida (ej: "Con capucha" /
  // "Sin capucha" dentro de "Sudaderas") — para sugerirlos con datalist sin
  // tener que mantener una lista aparte.
  const subcategorySuggestions = Array.from(
    new Set(
      templateProducts
        .filter((p) => p.category === draft.category && p.subcategory)
        .map((p) => p.subcategory)
    )
  );

  useEffect(() => {
    if (editing) {
      setDraft({
        id: editing.id,
        name: editing.name || "",
        description: editing.description || "",
        category: editing.category || "",
        subcategory: editing.subcategory || "",
        audience: editing.audience || "unisex",
        price: editing.price != null ? String(editing.price) : "",
        points: editing.points != null ? String(editing.points) : "",
        sku: editing.sku || "",
        sizes: editing.sizes || [],
        sizeGuide: editing.sizeGuide || [],
        sizeGuideImage: editing.sizeGuideImage || null,
        colors: (editing.colors || []).map((c) => ({
          name: c.name || "",
          hex: c.hex || "#E8452C",
          frontImage: c.frontImage || null,
          backImage: c.backImage || null,
          sleeveLeftImage: c.sleeveLeftImage || null,
          sleeveRightImage: c.sleeveRightImage || null,
        })),
      });
    } else {
      setDraft({ ...emptyTemplateDraft, category: categories[0] || "" });
    }
    setColorDraft(emptyTemplateColorDraft);
    setEditingColorIdx(null);
    setColorError("");
    setCustomSize("");
  }, [editing]);

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const handleZoneUpload = (zone, file) => {
    if (!file) return;
    const isPng = file.type === "image/png";
    fileToBase64(file, (b64) => setColorDraft((c) => ({ ...c, [zone]: b64 })), 1400, isPng ? 1 : 0.9, isPng ? "image/png" : "image/jpeg");
  };
  const removeZoneImage = (zone) => setColorDraft((c) => ({ ...c, [zone]: null }));
  const colorHasAnyPhoto = (c) => !!(c.frontImage || c.backImage || c.sleeveLeftImage || c.sleeveRightImage);

  const addColor = () => {
    if (!colorHasAnyPhoto(colorDraft)) { setColorError("Subí al menos la foto frontal de este color."); return; }
    setColorError("");
    const finalColor = colorDraft.name.trim()
      ? colorDraft
      : { ...colorDraft, name: `Color ${draft.colors.length + 1}` };
    if (editingColorIdx !== null) {
      setDraft((d) => ({ ...d, colors: d.colors.map((c, i) => (i === editingColorIdx ? finalColor : c)) }));
    } else {
      setDraft((d) => ({ ...d, colors: [...d.colors, finalColor] }));
    }
    setColorDraft(emptyTemplateColorDraft);
    setEditingColorIdx(null);
  };
  const editColor = (i) => { setColorDraft(draft.colors[i]); setEditingColorIdx(i); setColorError(""); };
  const cancelColorEdit = () => { setColorDraft(emptyTemplateColorDraft); setEditingColorIdx(null); setColorError(""); };
  const removeColor = (i) => {
    setDraft((d) => ({ ...d, colors: d.colors.filter((_, idx) => idx !== i) }));
    if (editingColorIdx === i) cancelColorEdit();
  };
  const addRolyToQueue = () => {
    if (!rolyInput.trim()) return;
    const { found, notFound } = lookupRolyColorsByNumbers(rolyInput);
    setRolyQueue((q) => {
      const already = new Set(q.map((c) => c.name));
      return [...q, ...found.filter((c) => !already.has(c.name))];
    });
    setRolyNotFound(notFound);
    setRolyInput("");
  };
  const useQueuedRolyColor = (i) => {
    const c = rolyQueue[i];
    if (!c) return;
    setColorDraft((d) => ({ ...d, name: c.name, hex: c.hex }));
    setRolyQueue((q) => q.filter((_, idx) => idx !== i));
  };
  // La foto que se ve en la tarjeta de esta prenda en el paso 1 de
  // "Personalizar" (y en la lista del panel) es siempre la del primer color
  // de la lista — antes eso quedaba fijado por el orden en que se cargaban
  // los colores, sin forma de elegirlo. Poner un color de "portada" lo manda
  // al principio de la lista, sin tocar nada más.
  const makeColorCover = (i) => {
    setDraft((d) => {
      if (i === 0) return d;
      const next = [...d.colors];
      const [c] = next.splice(i, 1);
      next.unshift(c);
      return { ...d, colors: next };
    });
    // Si estaba editando un color, cancelamos esa edición para no dejar el
    // formulario apuntando a un índice que ya cambió de lugar.
    if (editingColorIdx !== null) cancelColorEdit();
  };

  const toggleSize = (s) => setDraft((d) => ({ ...d, sizes: d.sizes.includes(s) ? d.sizes.filter((x) => x !== s) : [...d.sizes, s] }));
  const addCustomSize = () => {
    const s = customSize.trim().toUpperCase();
    if (!s || draft.sizes.includes(s)) return;
    setDraft((d) => ({ ...d, sizes: [...d.sizes, s] }));
    setCustomSize("");
  };

  const addCat = () => {
    if (!newCat.trim()) return;
    onAddCategory(newCat.trim());
    setDraft((d) => ({ ...d, category: newCat.trim() }));
    setNewCat("");
  };

  const ready = !!(draft.name.trim() && draft.category && draft.colors.length > 0);

  const handleSave = async () => {
    if (!ready) return;
    setSaving(true);
    const product = {
      id: draft.id || genId("p"),
      name: draft.name.trim(),
      description: draft.description.trim(),
      category: draft.category,
      subcategory: draft.subcategory.trim(),
      audience: draft.audience || "unisex",
      group: "",
      price: draft.price.toString().trim() ? Number(draft.price) : null,
      // Vacío = usa el puntaje general de Ajustes → Fidelización, igual que
      // en el formulario de productos normales.
      points: draft.points === "" || draft.points === null || draft.points === undefined ? null : Number(draft.points) || 0,
      // Código corto de referencia (ej: "BEAGLE-001") en vez del id interno.
      sku: draft.sku.trim() || generateSku(draft.name, templateProducts.filter((p) => p.id !== draft.id)),
      salePrice: null,
      // Bajo pedido — no se controla stock para las prendas de Personalizar.
      stock: 9999,
      tags: { bestseller: false, oferta: false, tendencia: false, template: true, customDesign: false },
      colors: draft.colors.map((c) => ({
        name: c.name.trim() || "Único",
        hex: c.hex,
        images: [c.frontImage, c.backImage, c.sleeveLeftImage, c.sleeveRightImage].filter(Boolean),
        frontImage: c.frontImage,
        backImage: c.backImage,
        sleeveLeftImage: c.sleeveLeftImage,
        sleeveRightImage: c.sleeveRightImage,
      })),
      designs: [],
      sizes: draft.sizes,
      photoPool: [],
      imageFit: "contain",
      imageBackground: null,
      sizeGuide: draft.sizeGuide || [],
      sizeGuideImage: draft.sizeGuideImage || null,
      createdAt: editing?.createdAt || Date.now(),
      salesCount: editing?.salesCount || 0,
    };
    await onSave(product);
    setSaving(false);
    setDraft({ ...emptyTemplateDraft, category: categories[0] || "" });
    setColorDraft(emptyTemplateColorDraft);
    setEditingColorIdx(null);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>{draft.id ? "Editar prenda para personalizar" : "Nueva prenda para personalizar"}</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Esta es una prenda (ej: "Camisetas", "Sudaderas con capucha") con todos los colores en los que la tenés — el cliente los va a ver juntos para elegir, como elegir un personaje, y recién ahí sube su diseño. No lleva stock porque se hace bajo pedido.
      </p>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Nombre de la prenda</label>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ej: Camisetas oversize" className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Descripción (de qué está hecha, composición, etc.)</label>
        <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} rows={3} placeholder="Ej: 100% algodón peinado, 220 g/m², oversize. Sublimación de alta duración." className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Se muestra cuando el cliente pasa el mouse (o toca, en el celular) sobre esta prenda al elegirla en "Personalizar".
        </p>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Categoría</label>
        <select value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle}>
          <option value="">Elegí una...</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex gap-2 mt-2">
          <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="Nueva categoría" className="flex-1 rounded-xl p-2 text-xs" style={inputStyle} />
          <button onClick={addCat} className="kulto-btn text-xs font-semibold rounded-xl px-3" style={{ background: "var(--sun)", color: "var(--ink)" }}>Añadir</button>
        </div>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Subgrupo / estilo (opcional)</label>
        <input
          list="template-subcategory-options"
          value={draft.subcategory}
          onChange={(e) => setDraft({ ...draft, subcategory: e.target.value })}
          placeholder="Ej: Con capucha, Oversize, Cuello en V..."
          className="w-full rounded-xl p-3 text-sm"
          style={inputStyle}
        />
        <datalist id="template-subcategory-options">
          {subcategorySuggestions.map((s) => <option key={s} value={s} />)}
        </datalist>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Si esta categoría tiene varios estilos (ej: en "Sudaderas": con o sin capucha), agrupalos acá. Si la dejás vacía, la prenda aparece directo dentro de la categoría.
        </p>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Para quién es</label>
        <select value={draft.audience} onChange={(e) => setDraft({ ...draft, audience: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle}>
          {AUDIENCE_OPTIONS.map((a) => <option key={a} value={a}>{AUDIENCE_LABELS[a]}</option>)}
        </select>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Elegí "Unisex" si el corte es suelto y le queda bien a cualquiera (ej: la mayoría de las oversize). Si el proveedor la vende puntualmente para hombre, mujer o niños, elegí esa opción — el cliente va a poder filtrar por esto al elegir el modelo.
        </p>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Precio de esta prenda (opcional)</label>
        <input
          type="number"
          min="0"
          step="0.01"
          value={draft.price}
          onChange={(e) => setDraft({ ...draft, price: e.target.value })}
          placeholder={`Vacío = usa la tarifa general de Personalizar`}
          className="w-full rounded-xl p-3 text-sm"
          style={inputStyle}
        />
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Dejalo vacío para usar la tarifa fija general (Ajustes → Personalizar). Completalo solo si esta prenda en particular tiene un precio distinto (ej: por su gramaje o tela).
        </p>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Puntos de fidelización (opcional)</label>
        <input
          type="number"
          min="0"
          value={draft.points}
          onChange={(e) => setDraft({ ...draft, points: e.target.value })}
          placeholder="Vacío = usa el general"
          className="w-full rounded-xl p-3 text-sm"
          style={inputStyle}
        />
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Cuántos puntos suma pedir esta prenda personalizada (por unidad). Dejalo vacío para usar el puntaje general de Ajustes → Fidelización.
        </p>
      </div>

      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Código de referencia (opcional)</label>
        <input
          type="text"
          value={draft.sku}
          onChange={(e) => setDraft({ ...draft, sku: e.target.value.toUpperCase() })}
          placeholder="Vacío = se genera solo, ej: BEAGLE-001"
          className="w-full rounded-xl p-3 text-sm"
          style={inputStyle}
        />
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Se usa como referencia corta en vez de un código largo — aparece en el mensaje de WhatsApp del pedido.
        </p>
      </div>

      <div>
        <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Colores ({draft.colors.length})</p>
        <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
          Agregá uno por cada color en el que tenés esta prenda — todos van a aparecer juntos para que el cliente elija. El primero (marcado "Portada") es la foto que se muestra en la tarjeta de esta prenda al elegir el modelo — tocá la estrella para cambiarlo.
        </p>
        {draft.colors.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {draft.colors.map((c, i) => (
              <div
                key={i}
                onClick={() => editColor(i)}
                className="kulto-btn flex items-center gap-1.5 rounded-full pl-1 pr-2 py-1"
                style={{ background: editingColorIdx === i ? "var(--signal)" : "var(--ink-3)", border: i === 0 ? "1px solid var(--sun)" : "1px solid var(--line)" }}
              >
                <span className="w-6 h-6 rounded-full overflow-hidden flex items-center justify-center shrink-0" style={{ background: c.hex }}>
                  {c.frontImage && <img loading="lazy" src={c.frontImage} className="w-full h-full object-contain" alt={c.name || "Color"} />}
                </span>
                <span className="text-xs" style={{ color: "var(--bone)" }}>{c.name || "(sin nombre)"}</span>
                {i === 0 ? (
                  <span className="text-[9px] font-semibold" style={{ color: "var(--sun)" }} title="Esta es la foto de portada">Portada</span>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); makeColorCover(i); }} style={{ color: "var(--sun)" }} title="Poner de portada" aria-label="Poner este color de portada">
                    <Star size={12} />
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); removeColor(i); }} style={{ color: "var(--bone)" }} aria-label="Quitar color"><X size={12} /></button>
              </div>
            ))}
          </div>
        )}

        <div className="mb-3 rounded-xl p-3" style={{ background: "var(--ink-3)", border: "1px dashed var(--line)" }}>
          <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
            Agregar por número de Roly: escribí todos los números de esta prenda de una (ej: "01, 47, 56, 777") y quedan esperando acá para que les subas la foto uno por uno.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              placeholder="ej: 01, 47, 56, 777"
              value={rolyInput}
              onChange={(e) => setRolyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRolyToQueue(); } }}
              className="rounded-xl p-2 text-sm flex-1 min-w-[160px]"
              style={inputStyle}
            />
            <button type="button" onClick={addRolyToQueue} className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full" style={{ background: "var(--signal)", color: "var(--bone)" }}>
              Agregar a la cola
            </button>
          </div>
          {rolyNotFound.length > 0 && (
            <p className="text-xs mt-2" style={{ color: "var(--signal)" }}>
              No encontré en el catálogo: {rolyNotFound.join(", ")}.
            </p>
          )}
          {rolyQueue.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2">
              {rolyQueue.map((c, i) => (
                <button
                  type="button"
                  key={c.name + i}
                  onClick={() => useQueuedRolyColor(i)}
                  className="kulto-btn flex items-center gap-1.5 rounded-full pl-1 pr-2 py-1"
                  style={{ background: "var(--ink)", border: "1px solid var(--line)" }}
                  title="Usar este color ahora"
                >
                  <span className="w-4 h-4 rounded-full" style={{ background: c.hex }} />
                  <span className="text-xs" style={{ color: "var(--bone)" }}>{c.name}</span>
                </button>
              ))}
            </div>
          )}
          {rolyQueue.length > 0 && (
            <p className="text-xs mt-2" style={{ color: "var(--slate)" }}>Tocá uno para cargarlo abajo y subirle la foto.</p>
          )}
        </div>

        <div className="rounded-2xl p-3 flex flex-col gap-3" style={{ background: "var(--ink-3)", border: "1px dashed var(--line)" }}>
          <p className="text-xs font-semibold" style={{ color: "var(--bone)" }}>
            {editingColorIdx !== null ? "Editando color" : "Agregar color"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input placeholder="Nombre o número (opcional)" value={colorDraft.name} onChange={(e) => setColorDraft({ ...colorDraft, name: e.target.value })} className="rounded-xl p-2 text-sm w-36" style={inputStyle} />
            <input type="color" value={colorDraft.hex} onChange={(e) => setColorDraft({ ...colorDraft, hex: e.target.value })} className="w-10 h-9 rounded" style={{ background: "transparent" }} />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {TEMPLATE_ZONE_DEFS.map((zdef) => {
              const img = colorDraft[zdef.key];
              return (
                <div key={zdef.key} className="flex flex-col items-center gap-1">
                  <label
                    className="kulto-btn relative w-full rounded-xl overflow-hidden flex items-center justify-center cursor-pointer"
                    style={{ aspectRatio: "4 / 5", background: "var(--ink)", border: img ? "2px solid var(--sun)" : "1px dashed var(--line)" }}
                  >
                    {img ? (
                      <img loading="lazy" src={img} className="w-full h-full object-contain" alt={zdef.label} />
                    ) : (
                      <span className="flex flex-col items-center gap-1 px-1 text-center">
                        <Upload size={18} style={{ color: "var(--slate)" }} />
                        <span className="text-[10px]" style={{ color: "var(--slate)" }}>Subir foto</span>
                      </span>
                    )}
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => { const f = e.target.files[0]; if (f) handleZoneUpload(zdef.key, f); e.target.value = ""; }}
                    />
                  </label>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] font-semibold" style={{ color: img ? "var(--sun)" : "var(--slate)" }}>{zdef.label}</span>
                    {img && (
                      <button type="button" onClick={() => removeZoneImage(zdef.key)} className="kulto-btn" style={{ color: "var(--slate)" }} title="Quitar foto">
                        <X size={11} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {colorError && <p className="text-xs" style={{ color: "var(--signal)" }}>{colorError}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={addColor} className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2" style={{ background: "var(--sun)", color: "var(--ink)" }}>
              {editingColorIdx !== null ? "Guardar color" : "Agregar color"}
            </button>
            {editingColorIdx !== null && (
              <button onClick={cancelColorEdit} className="kulto-btn text-xs px-3 py-2" style={{ color: "var(--slate)" }}>
                Cancelar edición
              </button>
            )}
          </div>
        </div>
        {draft.colors.length === 0 && (
          <p className="text-xs mt-2" style={{ color: "var(--signal)" }}>Agregá al menos un color antes de publicar.</p>
        )}
      </div>

      <div>
        <label className="text-xs mb-2 block" style={{ color: "var(--bone)" }}>Talles (opcional)</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {SIZE_PRESETS.map((s) => (
            <button key={s} onClick={() => toggleSize(s)} className="kulto-btn text-xs font-semibold rounded-full px-3 py-1.5" style={{ background: draft.sizes.includes(s) ? "var(--sun)" : "var(--ink-3)", color: draft.sizes.includes(s) ? "var(--ink)" : "var(--bone)" }}>
              {s}
            </button>
          ))}
          {draft.sizes.filter((s) => !SIZE_PRESETS.includes(s)).map((s) => (
            <button key={s} onClick={() => toggleSize(s)} className="kulto-btn text-xs font-semibold rounded-full px-3 py-1.5" style={{ background: "var(--sun)", color: "var(--ink)" }}>
              {s}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input value={customSize} onChange={(e) => setCustomSize(e.target.value)} placeholder="Otro talle" className="flex-1 rounded-xl p-2 text-xs" style={inputStyle} />
          <button onClick={addCustomSize} className="kulto-btn text-xs font-semibold rounded-xl px-3" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>Añadir</button>
        </div>
      </div>

      {draft.sizes.length > 0 && (
        <div>
          <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Guía de talles (opcional)</p>
          <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
            El cliente la ve al elegir el talle en "Personalizar" — cargarla ayuda a evitar devoluciones o quejas por el talle equivocado. Dejalo vacío si no querés mostrar guía en esta prenda.
          </p>
          {draft.sizes.map((s) => {
            const row = draft.sizeGuide?.find((g) => g.size === s);
            return (
              <div key={s} className="flex items-center gap-2 mb-2">
                <span className="text-xs font-semibold w-14 shrink-0" style={{ color: "var(--bone)" }}>{s}</span>
                <input
                  placeholder="Ej: Pecho 96cm · Largo 70cm"
                  value={row?.measurements || ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setDraft((d) => {
                      const rest = (d.sizeGuide || []).filter((g) => g.size !== s);
                      const next = val.trim() ? [...rest, { size: s, measurements: val }] : rest;
                      return { ...d, sizeGuide: next };
                    });
                  }}
                  className="rounded-xl p-2 text-sm flex-1"
                  style={inputStyle}
                />
              </div>
            );
          })}
          <div className="mt-3">
            <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
              ¿Preferís mostrar una foto con las medidas (por ejemplo, la tabla de talles del fabricante) en vez de escribirlas a mano? Subila acá — se muestra junto con (o en lugar de) la tabla de arriba.
            </p>
            <div className="flex items-center gap-3">
              {draft.sizeGuideImage && (
                <img src={draft.sizeGuideImage} alt="Guía de talles" className="w-20 h-20 object-cover rounded-xl" style={{ border: "1px solid var(--line)" }} />
              )}
              <label className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2 cursor-pointer" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}>
                {draft.sizeGuideImage ? "Cambiar imagen" : "Subir imagen"}
                <input
                  type="file" accept="image/png, image/jpeg" className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const isPng = f.type === "image/png";
                    fileToBase64(f, (b64) => setDraft((d) => ({ ...d, sizeGuideImage: b64 })), 1200, isPng ? 1 : 0.88, isPng ? "image/png" : "image/jpeg");
                  }}
                />
              </label>
              {draft.sizeGuideImage && (
                <button onClick={() => setDraft((d) => ({ ...d, sizeGuideImage: null }))} className="kulto-btn text-xs" style={{ color: "var(--signal)" }}>Quitar</button>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-1">
        <button
          disabled={!ready || saving}
          onClick={handleSave}
          className="kulto-btn flex-1 rounded-full py-3 font-semibold flex items-center justify-center gap-2"
          style={{ background: ready ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)", opacity: ready ? 1 : 0.6 }}
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />} {draft.id ? "Guardar cambios" : "Publicar prenda"}
        </button>
        {draft.id && (
          <button onClick={() => { setDraft({ ...emptyTemplateDraft, category: categories[0] || "" }); setColorDraft(emptyTemplateColorDraft); setEditingColorIdx(null); onCancelEdit(); }} className="kulto-btn rounded-full px-5" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  );
}

function AdminPhotoInbox({ inbox, draftProducts, categories, groups = [], onAddFiles, onCreateProduct, onAddToExisting, onRemove }) {
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState(null); // null | "new" | "existing"
  const [newName, setNewName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [newPrice, setNewPrice] = useState("");
  const [existingId, setExistingId] = useState("");
  const [busy, setBusy] = useState(false);
  // Para elegir varias fotos rápido sin tocarlas una por una: click normal
  // marca/desmarca una sola; Shift+click marca todo el rango desde la
  // última que tocaste; y arrastrando el mouse sobre la grilla (como
  // seleccionar íconos en el escritorio) se marcan todas las que toque el
  // recuadro. "Marcar todo" hace lo mismo de una.
  const lastClickedRef = useRef(null);
  const itemRefs = useRef({});
  const dragInfoRef = useRef(null); // { startX, startY, moved }
  const [dragRect, setDragRect] = useState(null); // en coordenadas de pantalla (clientX/Y)

  const toggleSelect = (id, index, shiftKey) => {
    if (shiftKey && lastClickedRef.current != null) {
      const [from, to] = [lastClickedRef.current, index].sort((a, b) => a - b);
      const rangeIds = inbox.slice(from, to + 1).map((it) => it.id);
      setSelected((prev) => Array.from(new Set([...prev, ...rangeIds])));
    } else {
      setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
    }
    lastClickedRef.current = index;
  };
  const selectAll = () => setSelected(inbox.map((i) => i.id));
  const selectNone = () => setSelected([]);

  const rectsIntersect = (a, b) => !(b.left > a.right || b.right < a.left || b.top > a.bottom || b.bottom < a.top);

  const onGridMouseDown = (e) => {
    if (e.button !== 0) return;
    dragInfoRef.current = { startX: e.clientX, startY: e.clientY, moved: false };
  };

  useEffect(() => {
    const onMove = (e) => {
      if (!dragInfoRef.current) return;
      const { startX, startY } = dragInfoRef.current;
      if (!dragInfoRef.current.moved && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
      dragInfoRef.current.moved = true;
      setDragRect({
        left: Math.min(startX, e.clientX), right: Math.max(startX, e.clientX),
        top: Math.min(startY, e.clientY), bottom: Math.max(startY, e.clientY),
      });
    };
    const onUp = () => {
      if (dragInfoRef.current?.moved) {
        setDragRect((rect) => {
          if (rect) {
            const idsInRect = [];
            for (const item of inbox) {
              const el = itemRefs.current[item.id];
              if (!el) continue;
              if (rectsIntersect(rect, el.getBoundingClientRect())) idsInRect.push(item.id);
            }
            if (idsInRect.length) setSelected((prev) => Array.from(new Set([...prev, ...idsInRect])));
          }
          return null;
        });
      }
      dragInfoRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [inbox]);

  const selectedImages = inbox.filter((i) => selected.includes(i.id)).map((i) => i.image);
  const inputStyle = { background: "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" };

  const reset = () => { setSelected([]); setMode(null); setNewName(""); setNewCategory(""); setNewGroup(""); setNewPrice(""); setExistingId(""); };

  const confirmNew = async () => {
    if (!newName.trim() || !newCategory || !newPrice) return;
    setBusy(true);
    await onCreateProduct({ name: newName.trim(), category: newCategory, group: newGroup, price: newPrice }, selectedImages, selected);
    setBusy(false);
    reset();
  };
  const confirmExisting = async () => {
    if (!existingId) return;
    setBusy(true);
    await onAddToExisting(existingId, selectedImages, selected);
    setBusy(false);
    reset();
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Subida masiva de fotos</h4>
          <p className="text-xs" style={{ color: "var(--slate)" }}>Subí todos tus mockups de una vez. Después elegís, foto por foto (o varias juntas), a qué producto van.</p>
        </div>
        <label className="kulto-btn shrink-0 text-xs font-semibold rounded-xl px-3 py-2 flex items-center gap-1" style={{ background: "var(--signal)", color: "var(--bone)" }}>
          <Upload size={14} /> Subir fotos
          <input
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files.length) onAddFiles(e.target.files); e.target.value = ""; }}
          />
        </label>
      </div>

      {inbox.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--slate)" }}>No hay fotos esperando para asignar.</p>
      ) : (
        <>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs" style={{ color: "var(--sun)" }}>
              {inbox.length} foto(s) sin asignar{selected.length > 0 ? ` · ${selected.length} seleccionada(s)` : ""}
            </p>
            <div className="flex items-center gap-2">
              <button onClick={selectAll} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                Marcar todo
              </button>
              {selected.length > 0 && (
                <button onClick={selectNone} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                  Ninguno
                </button>
              )}
            </div>
          </div>
          <p className="text-[11px]" style={{ color: "var(--slate)" }}>
            Tip: arrastrá el mouse sobre las fotos para marcar varias de una, o mantené Shift al hacer click para marcar todo un rango.
          </p>
          <div className="flex flex-wrap gap-2 select-none" onMouseDown={onGridMouseDown}>
            {inbox.map((item, idx) => (
              <div key={item.id} className="relative" ref={(el) => { itemRefs.current[item.id] = el; }}>
                <button
                  onClick={(e) => toggleSelect(item.id, idx, e.shiftKey)}
                  className="kulto-btn w-16 h-16 rounded-lg overflow-hidden"
                  style={{ border: selected.includes(item.id) ? "2px solid var(--sun)" : "1px solid var(--line)", background: "var(--ink-3)" }}
                >
                  <img loading="lazy" src={item.image} className="w-full h-full object-contain pointer-events-none" alt="" />
                  {selected.includes(item.id) && (
                    <span className="absolute inset-0 flex items-center justify-center pointer-events-none" style={{ background: "rgba(21,19,26,0.5)" }}>
                      <Check size={18} color="var(--sun)" />
                    </span>
                  )}
                </button>
                <button
                  onClick={() => onRemove([item.id])}
                  className="kulto-btn absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            {dragRect && (
              <div
                className="fixed pointer-events-none"
                style={{
                  left: dragRect.left, top: dragRect.top,
                  width: dragRect.right - dragRect.left, height: dragRect.bottom - dragRect.top,
                  background: "rgba(244,196,48,0.15)", border: "1px solid var(--sun)", zIndex: 999,
                }}
              />
            )}
          </div>

          {selected.length > 0 && (
            <div className="flex flex-col gap-3 rounded-xl p-3" style={{ background: "var(--ink-3)" }}>
              {!mode && (
                <div className="flex gap-2">
                  <button onClick={() => setMode("new")} className="kulto-btn flex-1 text-xs font-semibold rounded-xl py-2.5" style={{ background: "var(--sun)", color: "var(--ink)" }}>
                    Crear producto nuevo
                  </button>
                  <button
                    onClick={() => setMode("existing")}
                    disabled={!draftProducts.length}
                    className="kulto-btn flex-1 text-xs font-semibold rounded-xl py-2.5"
                    style={{ background: "var(--ink-2)", color: "var(--bone)", opacity: draftProducts.length ? 1 : 0.5 }}
                  >
                    Agregar a producto existente
                  </button>
                  <button
                    onClick={() => {
                      if (window.confirm(`¿Borrar ${selected.length} foto${selected.length === 1 ? "" : "s"} seleccionada${selected.length === 1 ? "" : "s"}? Esta acción no se puede deshacer.`)) {
                        onRemove(selected);
                        setSelected([]);
                      }
                    }}
                    className="kulto-btn shrink-0 text-xs font-semibold rounded-xl py-2.5 px-3 flex items-center gap-1"
                    style={{ background: "var(--ink-2)", color: "var(--signal)" }}
                  >
                    <Trash2 size={14} /> Borrar
                  </button>
                </div>
              )}

              {mode === "new" && (
                <div className="flex flex-col gap-2">
                  <input placeholder="Nombre del producto" value={newName} onChange={(e) => setNewName(e.target.value)} className="rounded-lg p-2.5 text-sm" style={inputStyle} />
                  <select value={newCategory} onChange={(e) => setNewCategory(e.target.value)} className="rounded-lg p-2.5 text-sm" style={inputStyle}>
                    <option value="">Categoría</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  {groups.length > 0 && (
                    <select value={newGroup} onChange={(e) => setNewGroup(e.target.value)} className="rounded-lg p-2.5 text-sm" style={inputStyle}>
                      <option value="">Grupo / temática (opcional)</option>
                      {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  )}
                  <input type="number" placeholder="Precio (€)" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} className="rounded-lg p-2.5 text-sm" style={inputStyle} />
                  <div className="flex gap-2">
                    <button disabled={busy} onClick={confirmNew} className="kulto-btn flex-1 text-xs font-semibold rounded-xl py-2.5" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                      Crear con {selected.length} foto{selected.length === 1 ? "" : "s"}
                    </button>
                    <button onClick={reset} className="kulto-btn text-xs px-3" style={{ color: "var(--slate)" }}>Cancelar</button>
                  </div>
                </div>
              )}

              {mode === "existing" && (
                <div className="flex flex-col gap-2">
                  <select value={existingId} onChange={(e) => setExistingId(e.target.value)} className="rounded-lg p-2.5 text-sm" style={inputStyle}>
                    <option value="">Elegí el producto</option>
                    {draftProducts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                  <div className="flex gap-2">
                    <button disabled={busy} onClick={confirmExisting} className="kulto-btn flex-1 text-xs font-semibold rounded-xl py-2.5" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                      Agregar {selected.length} foto{selected.length === 1 ? "" : "s"}
                    </button>
                    <button onClick={reset} className="kulto-btn text-xs px-3" style={{ color: "var(--slate)" }}>Cancelar</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Carga rápida para cuando hay muchos diseños distintos para subir (ej: más
// de 1000) y cada foto es un producto propio, no varias fotos de la misma
// prenda — a diferencia de "Subida masiva de fotos" de arriba, acá NO hace
// falta escribir un nombre por cada uno: se elige una categoría y un precio
// una sola vez para toda la tanda, se suben todas las fotos juntas (o una
// carpeta entera), y cada una se convierte en un producto propio con nombre
// automático "Categoría_01", "Categoría_02", etc.
function AdminBulkProductUpload({ categories, groups = [], allProducts = [], onSaveProduct }) {
  const [category, setCategory] = useState("");
  // El grupo/temática (ej: "kulto", "anime", "coches") es lo que de verdad
  // organiza los diseños para el dueño — la categoría es solo la prenda
  // física (camiseta, sudadera, etc). Por eso el nombre automático y el
  // agrupado de la lista de productos usan el grupo primero.
  const [group, setGroup] = useState("");
  const [baseName, setBaseName] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState("");
  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };
  const ready = category && String(price).trim();

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter((f) => f.type === "image/png" || f.type === "image/jpeg");
    if (!files.length || !ready) return;
    setUploading(true);
    setError("");
    setDone(0);
    setTotal(files.length);
    const name = baseName.trim() || group || category;
    // Cada producto de esta tanda necesita su propio código (sku) — vamos
    // sumando los que ya creamos acá mismo a la lista de "usados", porque
    // todos comparten el mismo nombre base (ej: "Camisetas_01", "_02"...).
    let knownProducts = allProducts;
    let n = 0;
    let failed = 0;
    for (const file of files) {
      n += 1;
      try {
        const isPng = file.type === "image/png";
        const b64 = await new Promise((resolve) => fileToBase64(file, resolve, 1400, isPng ? 1 : 0.88, isPng ? "image/png" : "image/jpeg"));
        const productName = `${name}_${String(n).padStart(2, "0")}`;
        const product = {
          id: genId("p"),
          name: productName,
          description: "",
          category,
          group,
          price: Number(price) || 0,
          salePrice: null,
          stock: Number(stock) || 0,
          points: null,
          sku: generateSku(productName, knownProducts),
          tags: { bestseller: false, oferta: false, tendencia: false, template: false, customDesign: false },
          colors: [],
          designs: [],
          sizes: [],
          photoPool: [b64],
          imageFit: "contain",
          imageBackground: null,
          sizeGuide: [],
          sizeGuideImage: null,
          designGroup: "",
          createdAt: Date.now(),
          salesCount: 0,
          viewsCount: 0,
        };
        knownProducts = [...knownProducts, product];
        await onSaveProduct(product);
        setDone(n);
      } catch {
        failed += 1;
      }
    }
    setUploading(false);
    if (failed > 0) setError(`${failed} de ${files.length} no se pudieron subir. Probá de nuevo con esas.`);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Carga rápida de muchos diseños</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Para cuando tenés un montón de diseños distintos (cada foto es una prenda propia, no varias fotos de la misma). Elegí la categoría y el precio una sola vez, subí todas las fotos juntas (o una carpeta entera) y cada una se crea sola como un producto — sin que tengas que escribirle un nombre a cada una.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {groups.length > 0 && (
          <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded-xl p-2.5 text-sm flex-1 min-w-[140px]" style={inputStyle}>
            <option value="">Grupo / temática (ej: kulto, anime, coches)…</option>
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        )}
        <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-xl p-2.5 text-sm flex-1 min-w-[140px]" style={inputStyle}>
          <option value="">Elegí la prenda (categoría)…</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input
          placeholder="Nombre base (opcional — si lo dejás vacío usa el grupo o la categoría)"
          value={baseName}
          onChange={(e) => setBaseName(e.target.value)}
          className="rounded-xl p-2.5 text-sm flex-1 min-w-[180px]"
          style={inputStyle}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input placeholder="Precio (para todas)" type="number" value={price} onChange={(e) => setPrice(e.target.value)} className="rounded-xl p-2.5 text-sm flex-1 min-w-[140px]" style={inputStyle} />
        <input placeholder="Stock (para todas, opcional)" type="number" value={stock} onChange={(e) => setStock(e.target.value)} className="rounded-xl p-2.5 text-sm flex-1 min-w-[140px]" style={inputStyle} />
      </div>
      {!ready && <p className="text-xs" style={{ color: "var(--signal)" }}>Elegí categoría y precio antes de subir las fotos.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2 shrink-0" style={{ background: !ready || uploading ? "var(--ink-3)" : "var(--signal)", color: "var(--bone)", opacity: !ready ? 0.6 : 1 }}>
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} {uploading ? `Subiendo… (${done}/${total})` : "Subir fotos"}
          <input type="file" accept="image/png,image/jpeg" multiple className="hidden" disabled={!ready || uploading} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
        </label>
        <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2 shrink-0" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)", opacity: !ready ? 0.6 : 1 }}>
          <FolderPlus size={16} /> Subir carpeta
          <input
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            disabled={!ready || uploading}
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
          />
        </label>
      </div>
      {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
      {!uploading && done > 0 && <p className="text-xs flex items-center gap-1" style={{ color: "var(--sun)" }}><Check size={12} /> Se crearon {done} productos en "{group || category}".</p>}
    </div>
  );
}

function AdminTagManager({ title, items, noun, onRename, onDelete }) {
  const [editingItem, setEditingItem] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [warning, setWarning] = useState("");

  const startEdit = (c) => { setEditingItem(c); setRenameValue(c); setWarning(""); };

  const saveRename = async () => {
    if (!renameValue.trim() || renameValue.trim() === editingItem) { setEditingItem(null); return; }
    await onRename(editingItem, renameValue.trim());
    setEditingItem(null);
  };

  const handleDelete = async (c) => {
    if (!window.confirm(`¿Borrar "${c}"? Esta acción no se puede deshacer.`)) return;
    const res = await onDelete(c);
    if (!res.ok) setWarning(`No se puede borrar "${c}" porque todavía hay productos en ese ${noun}.`);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>{title}</h4>
      {warning && <p className="text-xs" style={{ color: "var(--signal)" }}>{warning}</p>}
      {items.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--slate)" }}>Todavía no creaste ninguno.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {items.map((c) => (
            <div key={c} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: "var(--ink-3)" }}>
              {editingItem === c ? (
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveRename()}
                  className="flex-1 rounded-lg px-2 py-1 text-sm"
                  style={{ background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
                />
              ) : (
                <span className="flex-1 text-sm" style={{ color: "var(--bone)" }}>{c}</span>
              )}
              {editingItem === c ? (
                <button onClick={saveRename} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--sun)" }}><Check size={15} /></button>
              ) : (
                <button onClick={() => startEdit(c)} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--bone)" }}><Pencil size={15} /></button>
              )}
              <button onClick={() => handleDelete(c)} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--signal)" }}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminCategoryManager({ categories, onRename, onDelete }) {
  return <AdminTagManager title="Categorías" items={categories} noun="categoría" onRename={onRename} onDelete={onDelete} />;
}

function AdminGroupManager({ groups, onRename, onDelete }) {
  return <AdminTagManager title="Grupos / temáticas" items={groups} noun="grupo" onRename={onRename} onDelete={onDelete} />;
}

function AdminCustomers({ customers, onAdjustPoints, loyaltyThreshold, isOwner, onSetAdminPermissions, onDeleteCustomer, onCreateCustomer, onUpdateCustomerInfo, onSendPasswordHelp }) {
  const [editingEmail, setEditingEmail] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [permissionsOpenFor, setPermissionsOpenFor] = useState(null);
  const [permissionDrafts, setPermissionDrafts] = useState({});
  const [permissionsSavedFor, setPermissionsSavedFor] = useState(null);
  // Editar nombre/email a mano, por si el cliente cargó algo mal.
  const [editingInfoFor, setEditingInfoFor] = useState(null);
  const [infoDraft, setInfoDraft] = useState({ name: "", email: "" });
  const [infoError, setInfoError] = useState("");
  // Crear una cuenta a nombre de un cliente — le llega un mail para que elija
  // su propia contraseña, nosotros nunca la vemos ni la definimos.
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [createdEmail, setCreatedEmail] = useState("");
  // "Ayudarlo con la contraseña": le mandamos el mismo mail que recibiría si
  // pidiera "olvidé mi contraseña" — nunca vemos ni tocamos la contraseña.
  const [passwordHelpState, setPasswordHelpState] = useState({}); // { [email]: "sending" | "ok" | "error" }

  const startEdit = (c) => { setEditingEmail(c.email); setEditValue(String(c.points || 0)); };
  const save = (email) => {
    onAdjustPoints(email, Number(editValue) || 0);
    setEditingEmail(null);
  };

  const startEditInfo = (c) => { setEditingInfoFor(c.email); setInfoDraft({ name: c.name || "", email: c.email }); setInfoError(""); };
  const saveInfo = async (oldEmail) => {
    if (!infoDraft.email.trim() || !isValidEmail(infoDraft.email.trim())) { setInfoError("Ingresá un email válido."); return; }
    const result = await onUpdateCustomerInfo(oldEmail, { name: infoDraft.name, email: infoDraft.email });
    if (!result.ok) { setInfoError(result.error || "No se pudo guardar."); return; }
    setEditingInfoFor(null);
  };

  const createCustomer = async () => {
    setCreateError("");
    setCreatedEmail("");
    if (!newEmail.trim() || !isValidEmail(newEmail.trim())) { setCreateError("Ingresá un email válido."); return; }
    setCreating(true);
    const result = await onCreateCustomer({ name: newName, email: newEmail });
    setCreating(false);
    if (!result.ok) { setCreateError(result.error || "No se pudo crear la cuenta."); return; }
    setCreatedEmail(newEmail.trim());
    setNewName("");
    setNewEmail("");
  };

  const sendPasswordHelp = async (c) => {
    setPasswordHelpState((s) => ({ ...s, [c.email]: "sending" }));
    const result = await onSendPasswordHelp({ email: c.email });
    setPasswordHelpState((s) => ({ ...s, [c.email]: result.ok ? "ok" : "error" }));
    if (result.ok) setTimeout(() => setPasswordHelpState((s) => ({ ...s, [c.email]: undefined })), 2400);
  };

  // Permisos de admin: solo el dueño de la tienda (isOwner) puede ver y tocar
  // esto — así una cuenta de admin con permisos limitados nunca puede darse a
  // sí misma (ni a otra) más acceso del que ya tiene.
  const permsFor = (c) => permissionDrafts[c.email] || c.adminPermissions || [];
  const togglePerm = (c, key) => {
    const current = permsFor(c);
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    setPermissionDrafts((d) => ({ ...d, [c.email]: next }));
  };
  const savePermissions = async (c) => {
    await onSetAdminPermissions(c.email, permsFor(c));
    setPermissionsSavedFor(c.email);
    setTimeout(() => setPermissionsSavedFor(null), 1800);
  };
  const removeAdmin = async (c) => {
    await onSetAdminPermissions(c.email, []);
    setPermissionDrafts((d) => ({ ...d, [c.email]: [] }));
  };

  const deleteCustomer = (c) => {
    if (window.confirm(`¿Estás seguro que querés eliminar la cuenta de "${c.name || c.email}"? Esta acción no se puede deshacer.`)) {
      onDeleteCustomer(c.email);
    }
  };

  return (
    <div>
      <p className="text-sm font-semibold mb-1" style={{ color: "var(--bone)" }}>Clientes registrados ({customers.length})</p>
      <p className="text-xs mb-4" style={{ color: "var(--slate)" }}>
        Acá ves a quién le queda descuento de bienvenida sin usar y cuántos puntos tiene cada uno. Podés ajustar los puntos a mano — por ejemplo, al entregar la recompensa cuando alguien llega al umbral{loyaltyThreshold ? ` (cada ${loyaltyThreshold} puntos)` : ""}.
        {isOwner && " También podés convertir una cuenta en \"admin con permisos limitados\", eligiendo exactamente a qué secciones del panel puede entrar."}
      </p>

      <div className="rounded-2xl p-4 mb-4 flex flex-col gap-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
        <p className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--bone)" }}><UserPlus size={16} /> Crear cuenta para un cliente</p>
        <p className="text-xs" style={{ color: "var(--slate)" }}>
          Para cuando el cliente compró por WhatsApp y todavía no tiene cuenta, o pidió que se la crees vos. Le llega un mail para que elija su propia contraseña — nunca la vemos ni la definimos nosotros.
        </p>
        <div className="flex flex-col sm:flex-row gap-2">
          <input placeholder="Nombre" value={newName} onChange={(e) => setNewName(e.target.value)} className="flex-1 rounded-xl p-2.5 text-sm" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }} />
          <input type="email" placeholder="Email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} className="flex-1 rounded-xl p-2.5 text-sm" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }} />
          <button disabled={creating} onClick={createCustomer} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full shrink-0" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            {creating ? "Creando..." : "Crear y enviar mail"}
          </button>
        </div>
        {createError && <p className="text-xs" style={{ color: "var(--signal)" }}>{createError}</p>}
        {createdEmail && <p className="text-xs" style={{ color: "var(--sun)" }}>Cuenta creada — le mandamos un mail a {createdEmail} para que elija su contraseña.</p>}
      </div>

      {customers.length === 0 ? (
        <EmptyState text="Todavía no hay clientes registrados." />
      ) : (
        <div className="flex flex-col gap-2">
          {customers.map((c) => (
            <div key={c.email} className="rounded-2xl p-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
              {editingInfoFor === c.email ? (
                <div className="flex flex-col gap-2 mb-2">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input placeholder="Nombre" value={infoDraft.name} onChange={(e) => setInfoDraft((d) => ({ ...d, name: e.target.value }))} className="flex-1 rounded-lg p-2 text-sm" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }} />
                    <input type="email" placeholder="Email" value={infoDraft.email} onChange={(e) => setInfoDraft((d) => ({ ...d, email: e.target.value }))} className="flex-1 rounded-lg p-2 text-sm" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }} />
                  </div>
                  {infoError && <p className="text-xs" style={{ color: "var(--signal)" }}>{infoError}</p>}
                  <div className="flex items-center gap-2">
                    <button onClick={() => saveInfo(c.email)} className="kulto-btn text-xs font-semibold rounded-lg px-3 py-1.5" style={{ background: "var(--signal)", color: "var(--bone)" }}>Guardar</button>
                    <button onClick={() => setEditingInfoFor(null)} className="kulto-btn text-xs px-2" style={{ color: "var(--slate)" }}>Cancelar</button>
                  </div>
                </div>
              ) : null}
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate flex items-center gap-2" style={{ color: "var(--bone)" }}>
                    {c.name || c.email}
                    {c.adminPermissions && c.adminPermissions.length > 0 && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ background: "var(--sun)", color: "var(--ink)" }}>ADMIN</span>
                    )}
                    <button onClick={() => startEditInfo(c)} className="kulto-btn shrink-0" style={{ color: "var(--slate)" }} aria-label={`Editar datos de ${c.name || c.email}`} title="Editar nombre/email"><Pencil size={12} /></button>
                  </p>
                  <p className="text-xs truncate" style={{ color: "var(--slate)" }}>
                    {c.email} · {c.firstDiscountUsed ? "Ya usó su descuento" : "Descuento de bienvenida disponible"}
                  </p>
                </div>
                <button
                  onClick={() => sendPasswordHelp(c)}
                  disabled={passwordHelpState[c.email] === "sending"}
                  className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full shrink-0 flex items-center gap-1"
                  style={{ background: passwordHelpState[c.email] === "ok" ? "var(--sun)" : "var(--ink-3)", color: passwordHelpState[c.email] === "ok" ? "var(--ink)" : "var(--bone)" }}
                  title="Ayudarlo a crear o restablecer su contraseña, sin verla"
                >
                  <KeyRound size={13} />
                  {passwordHelpState[c.email] === "sending" ? "Enviando..." : passwordHelpState[c.email] === "ok" ? "Mail enviado" : passwordHelpState[c.email] === "error" ? "Reintentar" : "Contraseña"}
                </button>
                {editingEmail === c.email ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <input
                      type="number" min="0" value={editValue} onChange={(e) => setEditValue(e.target.value)}
                      className="w-16 rounded-lg p-1.5 text-sm text-center"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                    <button onClick={() => save(c.email)} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--sun)" }}><Check size={16} /></button>
                  </div>
                ) : (
                  <button onClick={() => startEdit(c)} className="kulto-btn text-sm font-semibold px-3 py-1.5 rounded-full shrink-0" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                    {c.points || 0} pts
                  </button>
                )}
                {isOwner && (
                  <button
                    onClick={() => setPermissionsOpenFor(permissionsOpenFor === c.email ? null : c.email)}
                    className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full shrink-0"
                    style={{ background: permissionsOpenFor === c.email ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                  >
                    Permisos
                  </button>
                )}
                <button
                  onClick={() => deleteCustomer(c)}
                  className="kulto-btn p-1.5 rounded-full shrink-0"
                  style={{ color: "var(--signal)" }}
                  aria-label={`Eliminar cuenta de ${c.name || c.email}`}
                  title="Eliminar cuenta"
                >
                  <Trash2 size={16} />
                </button>
              </div>
              {isOwner && permissionsOpenFor === c.email && (
                <div className="mt-3 pt-3 flex flex-col gap-2" style={{ borderTop: "1px dashed var(--line)" }}>
                  <p className="text-xs" style={{ color: "var(--slate)" }}>Tildá a qué secciones del panel de administrador puede entrar esta cuenta:</p>
                  <div className="flex flex-wrap gap-2">
                    {ADMIN_TABS.map(([key, label]) => (
                      <label
                        key={key}
                        className="kulto-btn flex items-center gap-1.5 text-xs rounded-full pl-2 pr-3 py-1.5"
                        style={{ background: permsFor(c).includes(key) ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                      >
                        <input type="checkbox" checked={permsFor(c).includes(key)} onChange={() => togglePerm(c, key)} />
                        {label}
                      </label>
                    ))}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <button
                      onClick={() => savePermissions(c)}
                      className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2"
                      style={{ background: permissionsSavedFor === c.email ? "var(--sun)" : "var(--signal)", color: permissionsSavedFor === c.email ? "var(--ink)" : "var(--bone)" }}
                    >
                      {permissionsSavedFor === c.email ? "Guardado" : "Guardar permisos"}
                    </button>
                    {c.adminPermissions && c.adminPermissions.length > 0 && (
                      <button onClick={() => removeAdmin(c)} className="kulto-btn text-xs px-2" style={{ color: "var(--slate)" }}>Quitar todo el acceso</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AdminOrders({ orders, onToggleStatus, onUpdateTracking, onApplyDiscount, onRequestReview, onBulkComplete, onBulkArchive, onBulkDelete }) {
  const [openId, setOpenId] = useState(null);
  const [trackingDrafts, setTrackingDrafts] = useState({});
  const [savedId, setSavedId] = useState(null);
  const [selected, setSelected] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState(false);
  const [discountDrafts, setDiscountDrafts] = useState({});
  const [discountSavedId, setDiscountSavedId] = useState(null);
  const [reviewRequestState, setReviewRequestState] = useState({}); // { [orderId]: "sending" | "ok" | "error" }

  const requestReview = async (o) => {
    setReviewRequestState((s) => ({ ...s, [o.id]: "sending" }));
    const result = await onRequestReview(o);
    setReviewRequestState((s) => ({ ...s, [o.id]: result.ok ? "ok" : "error" }));
  };

  const visible = orders.filter((o) => (showArchived ? o.archived : !o.archived));
  const selectedInView = selected.filter((id) => visible.some((o) => o.id === id));

  const trackingFor = (o) => (o.id in trackingDrafts ? trackingDrafts[o.id] : (o.trackingNumber || ""));
  const saveTracking = async (o) => {
    await onUpdateTracking(o, trackingFor(o));
    setSavedId(o.id);
    setTimeout(() => setSavedId(null), 1800);
  };

  // Descuento manual sobre un pedido ya hecho (ej: compensar algo que pasó).
  // Se guarda por separado del descuento de bienvenida (o.discountAmount) para
  // no pisarlo, y el total del pedido se recalcula al aplicarlo o quitarlo.
  const defaultDiscountDraft = (o) => ({
    mode: o.manualDiscountMode || "monto",
    value: o.manualDiscountMode === "porcentaje" ? String(o.manualDiscountPercent ?? "") : String(o.manualDiscountAmount || ""),
    reason: o.manualDiscountReason || "",
  });
  const discountDraftFor = (o) => discountDrafts[o.id] || defaultDiscountDraft(o);
  const updateDiscountDraft = (o, patch) => setDiscountDrafts((d) => ({ ...d, [o.id]: { ...discountDraftFor(o), ...patch } }));
  const applyDiscount = async (o) => {
    const draft = discountDraftFor(o);
    const numValue = Number(draft.value) || 0;
    const amount = draft.mode === "porcentaje" ? Math.round(o.subtotal * (numValue / 100)) : Math.round(numValue);
    await onApplyDiscount(o, { mode: draft.mode, amount, percent: draft.mode === "porcentaje" ? numValue : null, reason: draft.reason });
    setDiscountSavedId(o.id);
    setTimeout(() => setDiscountSavedId(null), 1800);
  };
  const removeDiscount = async (o) => {
    await onApplyDiscount(o, { mode: null, amount: 0, percent: null, reason: "" });
    setDiscountDrafts((d) => { const next = { ...d }; delete next[o.id]; return next; });
  };

  const toggleSelect = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const clearSelection = () => { setSelected([]); setConfirmingDelete(false); setPassword(""); setPasswordError(false); };

  const confirmDelete = () => {
    if (password !== ADMIN_PASSWORD) { setPasswordError(true); return; }
    onBulkDelete(selectedInView);
    clearSelection();
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2">
          <button
            onClick={() => { setShowArchived(false); clearSelection(); }}
            className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ background: !showArchived ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
          >
            Activos
          </button>
          <button
            onClick={() => { setShowArchived(true); clearSelection(); }}
            className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
            style={{ background: showArchived ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
          >
            Archivados
          </button>
        </div>
      </div>

      {selectedInView.length > 0 && (
        <div className="rounded-xl p-3 flex flex-wrap items-center gap-2" style={{ background: "var(--ink-2)", border: "1px solid var(--sun)" }}>
          <span className="text-xs font-semibold" style={{ color: "var(--sun)" }}>{selectedInView.length} seleccionado(s)</span>
          {!confirmingDelete ? (
            <>
              <button onClick={() => { onBulkComplete(selectedInView); clearSelection(); }} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                Marcar completado
              </button>
              <button onClick={() => { onBulkArchive(selectedInView, !showArchived); clearSelection(); }} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                {showArchived ? "Desarchivar" : "Archivar"}
              </button>
              <button onClick={() => setConfirmingDelete(true)} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                Eliminar
              </button>
              <button onClick={clearSelection} className="kulto-btn text-xs px-2" style={{ color: "var(--slate)" }}>Cancelar</button>
            </>
          ) : (
            <>
              <span className="text-xs" style={{ color: "var(--bone)" }}>Escribí la contraseña de administrador para confirmar:</span>
              <input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setPasswordError(false); }}
                onKeyDown={(e) => e.key === "Enter" && confirmDelete()}
                className="rounded-lg p-1.5 text-xs w-32"
                style={{ background: "var(--ink-3)", color: "var(--bone)", border: passwordError ? "1px solid var(--signal)" : "1px solid var(--line)" }}
              />
              <button onClick={confirmDelete} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                Confirmar eliminación
              </button>
              <button onClick={() => { setConfirmingDelete(false); setPassword(""); setPasswordError(false); }} className="kulto-btn text-xs px-2" style={{ color: "var(--slate)" }}>Cancelar</button>
              {passwordError && <span className="text-xs w-full" style={{ color: "var(--signal)" }}>Contraseña incorrecta.</span>}
            </>
          )}
        </div>
      )}

      {visible.length === 0 && (
        <EmptyState text={showArchived ? "No hay pedidos archivados." : "Todavía no se han recibido pedidos."} />
      )}

      {visible.map((o) => (
        <div key={o.id} className="rounded-2xl p-4 flex gap-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <input
            type="checkbox"
            checked={selected.includes(o.id)}
            onChange={() => toggleSelect(o.id)}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 shrink-0"
          />
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-3 cursor-pointer" onClick={() => setOpenId(openId === o.id ? null : o.id)}>
              <div>
                <p className="font-semibold text-sm" style={{ color: "var(--bone)" }}>{o.id}</p>
                <p className="text-xs" style={{ color: "var(--slate)" }}>{formatDate(o.date)} · {o.items.length} artículo(s) · {formatPrice(o.total)}</p>
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); onToggleStatus(o); }}
                className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full shrink-0"
                style={{ background: o.status === "completado" ? "var(--sun)" : "var(--ink-3)", color: o.status === "completado" ? "var(--ink)" : "var(--bone)" }}
              >
                {o.status === "completado" ? "Completado" : "Pendiente"}
              </button>
            </div>
            {openId === o.id && (
              <div className="mt-3 pt-3 flex flex-col gap-2" style={{ borderTop: "1px solid var(--line)" }}>
                {o.items.map((it, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <p className="text-xs flex-1" style={{ color: "var(--slate)" }}>
                      {i + 1}. {it.name} · {it.colorName}{it.size ? ` · Talle ${it.size}` : ""}{it.designName ? ` · ${it.designName}` : ""} · x{it.qty} · {formatPrice(it.unitPrice)}
                    </p>
                    {it.designImage && (
                      <a href={it.designImage} target="_blank" rel="noreferrer" className="kulto-btn shrink-0 w-10 h-10 rounded-lg overflow-hidden" style={{ border: "1px solid var(--sun)" }} title="Ver diseño que subió el cliente">
                        <img loading="lazy" src={it.designImage} className="w-full h-full object-cover" alt="Diseño del cliente" />
                      </a>
                    )}
                    {it.previewImageFront && (
                      <a href={it.previewImageFront} target="_blank" rel="noreferrer" className="kulto-btn shrink-0 w-10 h-10 rounded-lg overflow-hidden relative" style={{ border: "1px solid var(--sun)" }} title="Ver cómo quedó adelante">
                        <img loading="lazy" src={it.previewImageFront} className="w-full h-full object-cover" alt="Adelante" />
                        <span className="absolute bottom-0 left-0 right-0 text-center text-[7px] font-bold" style={{ background: "rgba(21,19,26,0.8)", color: "var(--sun)" }}>ADEL.</span>
                      </a>
                    )}
                    {it.previewImageBack && (
                      <a href={it.previewImageBack} target="_blank" rel="noreferrer" className="kulto-btn shrink-0 w-10 h-10 rounded-lg overflow-hidden relative" style={{ border: "1px solid var(--sun)" }} title="Ver cómo quedó atrás">
                        <img loading="lazy" src={it.previewImageBack} className="w-full h-full object-cover" alt="Atrás" />
                        <span className="absolute bottom-0 left-0 right-0 text-center text-[7px] font-bold" style={{ background: "rgba(21,19,26,0.8)", color: "var(--sun)" }}>ATRÁS</span>
                      </a>
                    )}
                    {it.previewImageSleeveLeft && (
                      <a href={it.previewImageSleeveLeft} target="_blank" rel="noreferrer" className="kulto-btn shrink-0 w-10 h-10 rounded-lg overflow-hidden relative" style={{ border: "1px solid var(--sun)" }} title="Ver cómo quedó la manga izquierda">
                        <img loading="lazy" src={it.previewImageSleeveLeft} className="w-full h-full object-cover" alt="Manga izquierda" />
                        <span className="absolute bottom-0 left-0 right-0 text-center text-[6px] font-bold" style={{ background: "rgba(21,19,26,0.8)", color: "var(--sun)" }}>M.IZQ.</span>
                      </a>
                    )}
                    {it.previewImageSleeveRight && (
                      <a href={it.previewImageSleeveRight} target="_blank" rel="noreferrer" className="kulto-btn shrink-0 w-10 h-10 rounded-lg overflow-hidden relative" style={{ border: "1px solid var(--sun)" }} title="Ver cómo quedó la manga derecha">
                        <img loading="lazy" src={it.previewImageSleeveRight} className="w-full h-full object-cover" alt="Manga derecha" />
                        <span className="absolute bottom-0 left-0 right-0 text-center text-[6px] font-bold" style={{ background: "rgba(21,19,26,0.8)", color: "var(--sun)" }}>M.DER.</span>
                      </a>
                    )}
                  </div>
                ))}
                {o.customerName && <p className="text-xs" style={{ color: "var(--slate)" }}>Cliente: {o.customerName}</p>}
                {o.customerPhone && <p className="text-xs" style={{ color: "var(--slate)" }}>Teléfono: {o.customerPhone}</p>}
                {o.customerEmail && <p className="text-xs" style={{ color: "var(--slate)" }}>Email: {o.customerEmail}</p>}
                <p className="text-xs" style={{ color: "var(--slate)" }}>
                  Entrega: {o.deliveryMethod === "envio" ? `Envío a domicilio (${formatPrice(o.shippingCost || 0)})` : "Recoge en persona"}
                </p>
                {o.deliveryMethod === "envio" && o.address && <p className="text-xs" style={{ color: "var(--slate)" }}>Dirección: {formatAddress(o.address)}</p>}
                {o.comment && <p className="text-xs" style={{ color: "var(--slate)" }}>Comentario: {o.comment}</p>}

                <div className="mt-1 flex items-center gap-2">
                  <input
                    value={trackingFor(o)}
                    onChange={(e) => setTrackingDrafts((d) => ({ ...d, [o.id]: e.target.value }))}
                    placeholder="Número o link de seguimiento"
                    className="flex-1 rounded-lg p-2 text-xs"
                    style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  />
                  <button
                    onClick={() => saveTracking(o)}
                    className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2"
                    style={{ background: savedId === o.id ? "var(--sun)" : "var(--signal)", color: savedId === o.id ? "var(--ink)" : "var(--bone)" }}
                  >
                    {savedId === o.id ? "Guardado" : "Guardar"}
                  </button>
                </div>

                <div className="mt-2 pt-2 flex flex-col gap-2" style={{ borderTop: "1px dashed var(--line)" }}>
                  <p className="text-xs font-semibold" style={{ color: "var(--bone)" }}>Descuento manual (ej: compensar un problema)</p>
                  {o.manualDiscountAmount > 0 && (
                    <p className="text-xs" style={{ color: "var(--sun)" }}>
                      Descuento aplicado: {formatPrice(o.manualDiscountAmount)}{o.manualDiscountMode === "porcentaje" ? ` (${o.manualDiscountPercent}%)` : ""}{o.manualDiscountReason ? ` — ${o.manualDiscountReason}` : ""}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      onClick={() => updateDiscountDraft(o, { mode: "monto" })}
                      className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
                      style={{ background: discountDraftFor(o).mode === "monto" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                    >
                      Monto fijo
                    </button>
                    <button
                      onClick={() => updateDiscountDraft(o, { mode: "porcentaje" })}
                      className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full"
                      style={{ background: discountDraftFor(o).mode === "porcentaje" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                    >
                      Porcentaje
                    </button>
                    <input
                      type="number"
                      min="0"
                      value={discountDraftFor(o).value}
                      onChange={(e) => updateDiscountDraft(o, { value: e.target.value })}
                      placeholder={discountDraftFor(o).mode === "porcentaje" ? "% de descuento" : "Monto en $"}
                      className="rounded-lg p-2 text-xs w-28"
                      style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                  </div>
                  <input
                    value={discountDraftFor(o).reason}
                    onChange={(e) => updateDiscountDraft(o, { reason: e.target.value })}
                    placeholder="Motivo (opcional, ej: se retrasó el envío)"
                    className="rounded-lg p-2 text-xs"
                    style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => applyDiscount(o)}
                      className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2"
                      style={{ background: discountSavedId === o.id ? "var(--sun)" : "var(--signal)", color: discountSavedId === o.id ? "var(--ink)" : "var(--bone)" }}
                    >
                      {discountSavedId === o.id ? "Aplicado" : "Aplicar descuento"}
                    </button>
                    {o.manualDiscountAmount > 0 && (
                      <button onClick={() => removeDiscount(o)} className="kulto-btn text-xs px-2" style={{ color: "var(--slate)" }}>Quitar descuento</button>
                    )}
                  </div>
                </div>

                {o.status === "completado" && o.customerEmail && (
                  <div className="mt-2 pt-2 flex items-center gap-2 flex-wrap" style={{ borderTop: "1px dashed var(--line)" }}>
                    <button
                      onClick={() => requestReview(o)}
                      disabled={reviewRequestState[o.id] === "sending"}
                      className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2"
                      style={{ background: reviewRequestState[o.id] === "ok" ? "var(--sun)" : "var(--ink-3)", color: reviewRequestState[o.id] === "ok" ? "var(--ink)" : "var(--bone)" }}
                    >
                      {reviewRequestState[o.id] === "sending" ? "Enviando..." : reviewRequestState[o.id] === "ok" ? "Mail enviado" : "Pedir reseña"}
                    </button>
                    {reviewRequestState[o.id] === "error" && (
                      <span className="text-xs" style={{ color: "var(--signal)" }}>No se pudo enviar el mail.</span>
                    )}
                    {o.reviewRequestedAt && !reviewRequestState[o.id] && (
                      <span className="text-xs" style={{ color: "var(--slate)" }}>Ya se pidió el {formatDate(new Date(o.reviewRequestedAt).toISOString())}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Panel de ventas — resumen de ingresos + "en tendencia" automático  */
/* ------------------------------------------------------------------ */

function AdminSalesPanel({ products, orders, settings, onSaveSettings }) {
  const completedOrders = orders.filter((o) => o.status === "completado" && !o.archived);
  const totalRevenue = completedOrders.reduce((sum, o) => sum + (o.total || 0), 0);
  const activeOrders = orders.filter((o) => o.status !== "completado" && !o.archived).length;

  const trendingIds = computeTrendingIds(products, settings);
  const ranked = [...products]
    .map((p) => ({ ...p, score: (p.salesCount || 0) * 3 + (p.viewsCount || 0) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  const [autoEnabled, setAutoEnabled] = useState(settings?.trendingAutoEnabled ?? true);
  const [autoCount, setAutoCount] = useState(settings?.trendingAutoCount ?? 8);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setAutoEnabled(settings?.trendingAutoEnabled ?? true);
    setAutoCount(settings?.trendingAutoCount ?? 8);
  }, [settings?.trendingAutoEnabled, settings?.trendingAutoCount]);

  const saveConfig = async () => {
    await onSaveSettings({ ...settings, trendingAutoEnabled: autoEnabled, trendingAutoCount: Number(autoCount) || 8 });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <div className="rounded-2xl p-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <p className="text-xs" style={{ color: "var(--slate)" }}>Ingresos (completados)</p>
          <p className="text-xl font-bold" style={{ color: "var(--sun)" }}>{formatPrice(totalRevenue)}</p>
        </div>
        <div className="rounded-2xl p-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <p className="text-xs" style={{ color: "var(--slate)" }}>Pedidos completados</p>
          <p className="text-xl font-bold" style={{ color: "var(--bone)" }}>{completedOrders.length}</p>
        </div>
        <div className="rounded-2xl p-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
          <p className="text-xs" style={{ color: "var(--slate)" }}>Pedidos en curso</p>
          <p className="text-xl font-bold" style={{ color: "var(--bone)" }}>{activeOrders}</p>
        </div>
      </div>

      <div className="rounded-2xl p-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
        <div className="flex items-center gap-2 mb-2">
          <TrendingUp size={16} style={{ color: "var(--sun)" }} />
          <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>"En tendencia" automático</p>
        </div>
        <p className="text-xs mb-3" style={{ color: "var(--slate)" }}>
          Combina ventas (lo que más pesa) y vistas de cada prenda para armar la sección "Tendencia" del inicio, sin que tengas que estar tildando manualmente — se suma a lo que ya marcás a mano en cada producto, nunca lo reemplaza.
        </p>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <label className="kulto-btn flex items-center gap-2 text-sm" style={{ color: "var(--bone)" }}>
            <input type="checkbox" checked={autoEnabled} onChange={(e) => setAutoEnabled(e.target.checked)} />
            Activado
          </label>
          <label className="text-xs flex items-center gap-2" style={{ color: "var(--slate)" }}>
            Máximo de prendas en tendencia:
            <input
              type="number" min="1" max="30" value={autoCount}
              onChange={(e) => setAutoCount(e.target.value)}
              className="w-16 rounded-lg p-1.5 text-sm text-center"
              style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
            />
          </label>
          <button onClick={saveConfig} className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
            {saved ? "Guardado" : "Guardar"}
          </button>
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Ranking de interés (ventas + vistas)</p>
        {ranked.length === 0 || ranked[0].score === 0 ? (
          <EmptyState text="Todavía no hay ventas ni vistas registradas." />
        ) : (
          <div className="flex flex-col gap-2">
            {ranked.filter((p) => p.score > 0).map((p, i) => (
              <div key={p.id} className="rounded-xl p-3 flex items-center gap-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
                <span className="text-xs font-bold w-5 shrink-0" style={{ color: "var(--slate)" }}>{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate flex items-center gap-2" style={{ color: "var(--bone)" }}>
                    {p.name}
                    {trendingIds.has(p.id) && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0" style={{ background: "var(--sun)", color: "var(--ink)" }}>TENDENCIA</span>
                    )}
                  </p>
                  <p className="text-xs" style={{ color: "var(--slate)" }}>{p.salesCount || 0} vendidas · {p.viewsCount || 0} vistas</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Compras — qué reponer o encargar, según stock y pedidos de aviso   */
/* ------------------------------------------------------------------ */

function AdminRestockPanel({ products, onQuickRestock, settings, onSaveSettings }) {
  const threshold = settings?.lowStockThreshold ?? 3;
  const lowStock = products.filter((p) => (p.stock ?? 0) <= threshold).sort((a, b) => (a.stock ?? 0) - (b.stock ?? 0));

  const [subscriberCounts, setSubscriberCounts] = useState({});
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(lowStock.map(async (p) => [p.id, (await getRestockSubscribers(p.id)).length]));
      if (!cancelled) setSubscriberCounts(Object.fromEntries(entries));
    })();
    return () => { cancelled = true; };
  }, [products, settings?.lowStockThreshold]);

  const [addDrafts, setAddDrafts] = useState({});
  const [savedId, setSavedId] = useState(null);
  const addStock = async (p) => {
    const amount = Number(addDrafts[p.id]) || 0;
    if (amount <= 0) return;
    await onQuickRestock(p.id, amount);
    setAddDrafts((d) => ({ ...d, [p.id]: "" }));
    setSavedId(p.id);
    setTimeout(() => setSavedId(null), 1800);
  };

  const [thresholdDraft, setThresholdDraft] = useState(threshold);
  useEffect(() => { setThresholdDraft(threshold); }, [threshold]);
  const [thresholdSaved, setThresholdSaved] = useState(false);
  const saveThreshold = async () => {
    await onSaveSettings({ ...settings, lowStockThreshold: Number(thresholdDraft) || 0 });
    setThresholdSaved(true);
    setTimeout(() => setThresholdSaved(false), 1800);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Boxes size={18} style={{ color: "var(--sun)" }} />
        <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Prendas que conviene comprar o encargar</p>
      </div>
      <p className="text-xs -mt-2" style={{ color: "var(--slate)" }}>
        Como trabajás bajo pedido, acá ves qué prendas están sin stock o con poco, y cuántos clientes están esperando que vuelvan — para saber qué encargarle al proveedor antes de que te lo pidan.
      </p>

      <div className="flex items-center gap-2 rounded-xl p-3" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
        <label className="text-xs flex items-center gap-2" style={{ color: "var(--slate)" }}>
          Avisarme cuando el stock de una prenda sea igual o menor a:
          <input
            type="number" min="0" value={thresholdDraft}
            onChange={(e) => setThresholdDraft(e.target.value)}
            className="w-16 rounded-lg p-1.5 text-sm text-center"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
        </label>
        <button onClick={saveThreshold} className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2" style={{ background: thresholdSaved ? "var(--sun)" : "var(--signal)", color: thresholdSaved ? "var(--ink)" : "var(--bone)" }}>
          {thresholdSaved ? "Guardado" : "Guardar"}
        </button>
      </div>

      {lowStock.length === 0 ? (
        <EmptyState text="Por ahora ninguna prenda está por debajo del umbral de stock bajo." />
      ) : (
        <div className="flex flex-col gap-2">
          {lowStock.map((p) => (
            <div key={p.id} className="rounded-xl p-3 flex flex-wrap items-center gap-3" style={{ background: "var(--ink-2)", border: (p.stock ?? 0) <= 0 ? "1px solid var(--signal)" : "1px solid var(--line)" }}>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "var(--bone)" }}>{p.name}</p>
                <p className="text-xs" style={{ color: (p.stock ?? 0) <= 0 ? "var(--signal)" : "var(--slate)" }}>
                  {p.category} · Stock: {p.stock ?? 0}
                  {subscriberCounts[p.id] > 0 && ` · ${subscriberCounts[p.id]} cliente${subscriberCounts[p.id] === 1 ? "" : "s"} esperando aviso`}
                </p>
              </div>
              <input
                type="number" min="1" placeholder="Cant."
                value={addDrafts[p.id] || ""}
                onChange={(e) => setAddDrafts((d) => ({ ...d, [p.id]: e.target.value }))}
                className="w-20 rounded-lg p-2 text-sm text-center"
                style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
              />
              <button onClick={() => addStock(p)} className="kulto-btn text-xs font-semibold rounded-lg px-3 py-2" style={{ background: savedId === p.id ? "var(--sun)" : "var(--signal)", color: savedId === p.id ? "var(--ink)" : "var(--bone)" }}>
                {savedId === p.id ? "Sumado" : "Sumar stock"}
              </button>
            </div>
          ))}
          <p className="text-xs" style={{ color: "var(--slate)" }}>
            Sumar stock acá lo hace directo, sin pasar por "Publicar cambios" — si el stock pasa de 0 para arriba, se les avisa por mail automáticamente a los clientes que pidieron que les notifiquen.
          </p>
        </div>
      )}
    </div>
  );
}

const BANNER_FOCUS_OPTIONS = [
  ["center", "Centro"],
  ["top", "Arriba"],
  ["bottom", "Abajo"],
  ["left", "Izquierda"],
  ["right", "Derecha"],
];

// Marco ancho (estilo banner) para el recorte manual: dejar que el admin
// arrastre y haga zoom sobre la foto para elegir exactamente qué parte se ve,
// en vez de depender solo de los 5 focos predefinidos de arriba.
const BANNER_CROP_FRAME_W = 320;
const BANNER_CROP_FRAME_H = 130;
const BANNER_CROP_OUT_W = 1600;
const BANNER_CROP_OUT_H = 650;

function AdminBannerSettings({ settings, groups = [], onSave }) {
  const [heroTitle, setHeroTitle] = useState(settings.heroTitle);
  const [heroSubtitle, setHeroSubtitle] = useState(settings.heroSubtitle);
  // Compatibilidad: si la tienda todavía tiene la imagen vieja de portada
  // (un solo campo, "heroImage") y nunca cargó varias, arrancamos la lista
  // con esa — así no se pierde nada al actualizar.
  const initialHeroImages = () => (settings.heroImages && settings.heroImages.length ? settings.heroImages : (settings.heroImage ? [settings.heroImage] : []));
  const [heroImages, setHeroImages] = useState(initialHeroImages());
  const [banners, setBanners] = useState(settings.banners || []);
  const [draft, setDraft] = useState(null);
  const [saved, setSaved] = useState(false);
  const [cropSource, setCropSource] = useState(null);

  useEffect(() => {
    setHeroTitle(settings.heroTitle);
    setHeroSubtitle(settings.heroSubtitle);
    setHeroImages(initialHeroImages());
    setBanners(settings.banners || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const addHeroImages = (fileList) => {
    Array.from(fileList || []).forEach((f) => {
      const isPng = f.type === "image/png";
      fileToBase64(f, (b64) => setHeroImages((imgs) => [...imgs, b64]), 1200, 0.88, isPng ? "image/png" : "image/jpeg");
    });
  };
  const removeHeroImage = (img) => setHeroImages((imgs) => imgs.filter((i) => i !== img));

  const saveDefault = async () => {
    await onSave({ heroTitle, heroSubtitle, heroImages, heroImage: heroImages[0] || null });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const openNew = () => setDraft({
    id: genId("banner"),
    title: banners.length === 0 ? heroTitle : "",
    subtitle: banners.length === 0 ? heroSubtitle : "",
    image: banners.length === 0 ? (heroImages[0] || null) : null,
    ctaLabel: "Ver catálogo",
    ctaAction: "catalog",
    ctaUrl: "",
    ctaGroup: groups[0] || "",
    active: true,
    placement: "hero",
    size: "md",
    layout: "full",
    focus: "center",
    highlightColor: "#FFD447",
  });
  const openEdit = (b) => setDraft({ ...b });
  const closeDraft = () => setDraft(null);

  const handleDraftUpload = (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const isPng = f.type === "image/png";
    fileToBase64(f, (b64) => setDraft((d) => ({ ...d, image: b64 })), 1400, isPng ? 1 : 0.88, isPng ? "image/png" : "image/jpeg");
  };

  const handleCropConfirm = (croppedBase64) => {
    setDraft((d) => ({ ...d, image: croppedBase64 }));
    setCropSource(null);
  };
  const handleCropCancel = () => setCropSource(null);

  const persistBanners = async (next) => {
    setBanners(next);
    await onSave({ banners: next });
  };

  const saveDraft = async () => {
    if (!draft.title.trim()) return;
    const exists = banners.some((b) => b.id === draft.id);
    const next = exists ? banners.map((b) => (b.id === draft.id ? draft : b)) : [...banners, draft];
    await persistBanners(next);
    setDraft(null);
  };

  const removeBanner = (id) => persistBanners(banners.filter((b) => b.id !== id));
  const toggleActive = (id) => persistBanners(banners.map((b) => (b.id === id ? { ...b, active: b.active === false } : b)));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= banners.length) return;
    const next = [...banners];
    [next[i], next[j]] = [next[j], next[i]];
    persistBanners(next);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-5 max-w-2xl" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Banners</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Armá carteles con imagen, texto y botón, e ideal para ir cambiando según la temporada o el diseño del momento. Cada uno puede ir arriba de todo en el inicio (rotando si hay varios) o como una sección más entre los bloques de la página — vas a poder acomodarlos en "Secciones del inicio" de más abajo.
        </p>
      </div>

      {banners.length === 0 && <EmptyState text="Todavía no armaste ningún banner." />}

      <div className="flex flex-col gap-3">
        {banners.map((b, i) => (
          <div key={b.id} className="rounded-2xl p-3 flex items-center gap-3" style={{ background: "var(--ink-3)", border: "1px solid var(--line)", opacity: b.active === false ? 0.5 : 1 }}>
            <div className="flex flex-col gap-1 shrink-0">
              <button disabled={i === 0} onClick={() => move(i, -1)} className="kulto-btn p-1 rounded" style={{ color: i === 0 ? "var(--ink)" : "var(--bone)" }} aria-label="Subir banner"><ArrowUp size={14} /></button>
              <button disabled={i === banners.length - 1} onClick={() => move(i, 1)} className="kulto-btn p-1 rounded" style={{ color: i === banners.length - 1 ? "var(--ink)" : "var(--bone)" }} aria-label="Bajar banner"><ArrowDown size={14} /></button>
            </div>
            <div className="w-14 h-14 rounded-xl overflow-hidden flex items-center justify-center shrink-0" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
              {b.image ? <img loading="lazy" src={b.image} alt="" className="w-full h-full object-contain p-0.5" /> : <Shirt size={18} color="rgba(243,239,230,0.4)" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate" style={{ color: "var(--bone)" }}>{b.title || "(sin título)"}</p>
              <p className="text-xs truncate" style={{ color: "var(--slate)" }}>
                {b.active === false ? "Oculto" : "Activo"} · {b.placement === "section" ? "sección del inicio" : "portada (arriba de todo)"}
                {b.placement === "section" && (b.layout === "tile" ? " · estilo grilla" : b.layout === "row" ? " · ancho del catálogo" : " · de punta a punta")} · botón: {b.ctaLabel || "Ver catálogo"}
              </p>
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button onClick={() => toggleActive(b.id)} className="kulto-btn text-[11px] px-2 py-1 rounded-full font-semibold" style={{ background: b.active === false ? "var(--ink)" : "var(--sun)", color: b.active === false ? "var(--bone)" : "var(--ink)" }}>
                {b.active === false ? "Mostrar" : "Ocultar"}
              </button>
              <div className="flex gap-1 justify-end">
                <button onClick={() => openEdit(b)} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--bone)" }} aria-label="Editar banner"><Pencil size={14} /></button>
                <button onClick={() => { if (window.confirm(`¿Borrar el banner "${b.title || "sin título"}"? Esta acción no se puede deshacer.`)) removeBanner(b.id); }} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--signal)" }} aria-label="Borrar banner"><Trash2 size={14} /></button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {!draft && (
        <button onClick={openNew} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2 w-fit px-5" style={{ background: "var(--signal)", color: "var(--bone)" }}>
          <Plus size={16} /> Agregar banner
        </button>
      )}

      {draft && (
        <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
          <h5 className="text-sm font-semibold" style={{ color: "var(--bone)" }}>{banners.some((b) => b.id === draft.id) ? "Editar banner" : "Nuevo banner"}</h5>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Título</label>
            <textarea value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} rows={2} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Subtítulo</label>
            <textarea value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} rows={2} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Imagen (PNG o JPG)</label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-xl overflow-hidden flex items-center justify-center shrink-0" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
                {draft.image ? <img loading="lazy" src={draft.image} alt="" className="w-full h-full object-contain p-1" /> : <Shirt size={20} color="rgba(243,239,230,0.4)" />}
              </div>
              <div className="flex flex-col gap-2">
                <label className="kulto-btn text-xs flex items-center gap-1 rounded-xl px-3 py-2 w-fit" style={{ background: "var(--ink)", color: "var(--bone)" }}>
                  <Upload size={14} /> Subir imagen
                  <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleDraftUpload} />
                </label>
                {draft.image && (
                  <button onClick={() => setCropSource(draft.image)} className="kulto-btn text-xs flex items-center gap-1 rounded-xl px-3 py-2 w-fit" style={{ background: "var(--ink)", color: "var(--bone)" }}>
                    <ZoomIn size={14} /> Recortar / acomodar
                  </button>
                )}
                {draft.image && <button onClick={() => setDraft({ ...draft, image: null })} className="kulto-btn text-xs" style={{ color: "var(--signal)" }}>Quitar imagen</button>}
              </div>
            </div>
            {draft.image && (
              <p className="text-xs mt-2" style={{ color: "var(--slate)" }}>
                Tocá "Recortar / acomodar" para arrastrar la foto y hacerle zoom hasta dejar visible exactamente la parte que querés — no hace falta que sea la imagen entera.
              </p>
            )}
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Dónde va este banner</label>
            <select value={draft.placement || "hero"} onChange={(e) => setDraft({ ...draft, placement: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle}>
              <option value="hero">Arriba de todo, en la portada (rota con los demás)</option>
              <option value="section">Entre los bloques del inicio (por ejemplo, entre "Tendencia" y "En oferta")</option>
            </select>
            {draft.placement === "section" && (
              <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
                Después de guardarlo, andá a "Secciones del inicio" para ubicarlo donde quieras.
              </p>
            )}
          </div>
          {draft.placement === "section" && (
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Estilo del banner</label>
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => setDraft({ ...draft, layout: "full" })}
                  className="kulto-btn rounded-xl py-2 text-sm font-semibold"
                  style={{ background: (draft.layout || "full") === "full" ? "var(--signal)" : "var(--ink)", color: "var(--bone)" }}
                >
                  De punta a punta de la pantalla
                </button>
                <button
                  onClick={() => setDraft({ ...draft, layout: "row" })}
                  className="kulto-btn rounded-xl py-2 text-sm font-semibold"
                  style={{ background: draft.layout === "row" ? "var(--signal)" : "var(--ink)", color: "var(--bone)" }}
                >
                  Ancho del catálogo (mismo ancho que la grilla de productos)
                </button>
                <button
                  onClick={() => setDraft({ ...draft, layout: "tile" })}
                  className="kulto-btn rounded-xl py-2 text-sm font-semibold"
                  style={{ background: draft.layout === "tile" ? "var(--signal)" : "var(--ink)", color: "var(--bone)" }}
                >
                  Tarjeta (como los productos)
                </button>
              </div>
              <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
                {draft.layout === "tile"
                  ? "Se muestra del tamaño de una tarjeta de producto. Si ponés varios banners \"tarjeta\" seguidos en \"Secciones del inicio\", se acomodan solos en una fila tipo grilla."
                  : draft.layout === "row"
                  ? "Ocupa todo el ancho de la grilla de productos, de punta a punta de esa franja (con los mismos márgenes que las cajas de producto), pero sin llegar a los bordes reales de la pantalla."
                  : "Ocupa todo el ancho de la pantalla, como los banners de adidas.es."}
              </p>
            </div>
          )}
          {draft.placement === "section" && (
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Grosor del banner</label>
              <div className="flex gap-2">
                {[["sm", "Chico"], ["md", "Mediano"], ["lg", "Grande"]].map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setDraft({ ...draft, size: val })}
                    className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold"
                    style={{ background: (draft.size || "md") === val ? "var(--signal)" : "var(--ink)", color: "var(--bone)" }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {draft.placement === "section" && draft.layout === "row" && (
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Puntas del banner</label>
              <div className="flex gap-2">
                <button
                  onClick={() => setDraft({ ...draft, roundedCorners: false })}
                  className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold"
                  style={{ background: !draft.roundedCorners ? "var(--signal)" : "var(--ink)", color: "var(--bone)" }}
                >
                  Rectas
                </button>
                <button
                  onClick={() => setDraft({ ...draft, roundedCorners: true })}
                  className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold"
                  style={{ background: draft.roundedCorners ? "var(--signal)" : "var(--ink)", color: "var(--bone)" }}
                >
                  Redondeadas (como el resto)
                </button>
              </div>
            </div>
          )}
          {draft.image && (
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Qué parte de la foto se ve</label>
              <select value={draft.focus || "center"} onChange={(e) => setDraft({ ...draft, focus: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle}>
                {BANNER_FOCUS_OPTIONS.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
              </select>
              <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
                Útil cuando el banner recorta la foto por ser más chico que la imagen original — elegí qué parte querés que quede siempre visible.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Texto del botón</label>
              <input value={draft.ctaLabel} onChange={(e) => setDraft({ ...draft, ctaLabel: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
            </div>
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>El banner lleva a</label>
              <select value={draft.ctaAction} onChange={(e) => setDraft({ ...draft, ctaAction: e.target.value, ctaGroup: e.target.value === "group" ? (draft.ctaGroup || groups[0] || "") : draft.ctaGroup })} className="w-full rounded-xl p-3 text-sm" style={inputStyle}>
                <option value="catalog">Catálogo (todo)</option>
                <option value="group">Un grupo del catálogo</option>
                <option value="wizard">Personalizar</option>
                <option value="url">Un link</option>
                <option value="none">A ningún lado (no se puede clickear)</option>
              </select>
            </div>
          </div>
          {draft.ctaAction === "group" && (
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Grupo</label>
              {groups.length > 0 ? (
                <select value={draft.ctaGroup || ""} onChange={(e) => setDraft({ ...draft, ctaGroup: e.target.value })} className="w-full rounded-xl p-3 text-sm" style={inputStyle}>
                  {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                </select>
              ) : (
                <p className="text-xs" style={{ color: "var(--slate)" }}>Todavía no creaste grupos de catálogo. Creá uno primero en la pestaña "Productos".</p>
              )}
              <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
                Ej: un banner "Kulto Anime" que lleve directo al grupo "Anime" del catálogo.
              </p>
            </div>
          )}
          {draft.ctaAction === "url" && (
            <div>
              <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Link (https://...)</label>
              <input value={draft.ctaUrl} onChange={(e) => setDraft({ ...draft, ctaUrl: e.target.value })} placeholder="https://" className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
            </div>
          )}
          {draft.ctaAction !== "none" && (
            <>
              <p className="text-xs" style={{ color: "var(--slate)" }}>
                Todo el banner es clickeable (no hace falta tocar justo el botón): al pasar el mouse se agranda un poco y brilla con el color que elijas abajo.
              </p>
              <div>
                <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Color del brillo al pasar el mouse</label>
                <div className="flex items-center gap-3">
                  <input type="color" value={draft.highlightColor || "#FFD447"} onChange={(e) => setDraft({ ...draft, highlightColor: e.target.value })} className="w-12 h-9 rounded" style={{ background: "transparent" }} />
                  <span className="text-xs" style={{ color: "var(--slate)" }}>{draft.highlightColor || "#FFD447"}</span>
                </div>
              </div>
            </>
          )}
          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--bone)" }}>
            <input type="checkbox" checked={draft.active !== false} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} /> Mostrarlo en la web
          </label>
          <div className="flex gap-2">
            <button onClick={saveDraft} className="kulto-btn flex-1 rounded-full py-3 font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
              Guardar banner
            </button>
            <button onClick={closeDraft} className="kulto-btn rounded-full px-4" style={{ background: "var(--ink)", color: "var(--bone)" }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      <div className="pt-4 flex flex-col gap-4" style={{ borderTop: "1px solid var(--line)" }}>
        <div>
          <h5 className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Cartel por defecto</h5>
          <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>Se usa solo cuando no tenés ningún banner activo arriba.</p>
        </div>
        <div>
          <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Título</label>
          <textarea value={heroTitle} onChange={(e) => setHeroTitle(e.target.value)} rows={2} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
        </div>
        <div>
          <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Subtítulo</label>
          <textarea value={heroSubtitle} onChange={(e) => setHeroSubtitle(e.target.value)} rows={3} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
        </div>
        <div>
          <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Imagen decorativa (PNG o JPG)</label>
          <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
            Subí una o varias — cada una se ve tal cual la subiste, sin recortarla. Si cargás más de una, van cambiando solas cada 4 segundos.
          </p>
          <div className="flex flex-wrap gap-2">
            {heroImages.map((img, i) => (
              <div key={i} className="relative w-20 h-20 rounded-xl overflow-hidden shrink-0" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
                <img loading="lazy" src={img} alt="" className="w-full h-full object-contain p-1" />
                <button
                  onClick={() => removeHeroImage(img)}
                  className="kulto-btn absolute top-0.5 right-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(21,19,26,0.8)", color: "var(--bone)" }}
                  title="Quitar"
                  aria-label="Quitar imagen"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            <label
              className="kulto-btn w-20 h-20 rounded-xl flex flex-col items-center justify-center gap-1 shrink-0"
              style={{ background: "var(--ink-3)", border: "1px dashed var(--line)", color: "var(--slate)" }}
            >
              <Upload size={16} />
              <span className="text-[10px]">Agregar</span>
              <input type="file" accept="image/png,image/jpeg" multiple className="hidden" onChange={(e) => { addHeroImages(e.target.files); e.target.value = ""; }} />
            </label>
          </div>
        </div>
        <button onClick={saveDefault} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
          {saved ? <><Check size={16} /> Guardado</> : "Guardar cartel por defecto"}
        </button>
      </div>

      {cropSource && (
        <CropModal
          source={cropSource}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
          frameW={BANNER_CROP_FRAME_W}
          frameH={BANNER_CROP_FRAME_H}
          outW={BANNER_CROP_OUT_W}
          outH={BANNER_CROP_OUT_H}
          title="Arrastrá y hacé zoom para elegir qué parte del banner se ve"
        />
      )}
    </div>
  );
}

function AdminBrandSettings({ settings, onSave }) {
  const [logoImage, setLogoImage] = useState(settings.logoImage);
  const [logoText, setLogoText] = useState(settings.logoText || "");
  const [socialInstagram, setSocialInstagram] = useState(settings.socialInstagram || "");
  const [socialFacebook, setSocialFacebook] = useState(settings.socialFacebook || "");
  const [socialTiktok, setSocialTiktok] = useState(settings.socialTiktok || "");
  const [contactEmail, setContactEmail] = useState(settings.contactEmail || "");
  const [contactPhone, setContactPhone] = useState(settings.contactPhone || "");
  const [contactAddress, setContactAddress] = useState(settings.contactAddress || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLogoImage(settings.logoImage);
    setLogoText(settings.logoText || "");
    setSocialInstagram(settings.socialInstagram || "");
    setSocialFacebook(settings.socialFacebook || "");
    setSocialTiktok(settings.socialTiktok || "");
    setContactEmail(settings.contactEmail || "");
    setContactPhone(settings.contactPhone || "");
    setContactAddress(settings.contactAddress || "");
  }, [settings]);

  const handleUpload = (e) => {
    const f = e.target.files[0];
    // PNG keeps transparency — important for logos with no background.
    if (f) fileToBase64(f, (b64) => setLogoImage(b64), 512, 1, "image/png");
  };

  const save = async () => {
    await onSave({ logoImage, logoText, socialInstagram, socialFacebook, socialTiktok, contactEmail, contactPhone, contactAddress });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Marca</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Subí tu logo en PNG con fondo transparente para que se vea bien sobre el fondo oscuro. Se usa en la cabecera de la web y como ícono de la pestaña del navegador (favicon) — para el favicon, lo ideal es que sea cuadrado.
      </p>
      <div className="flex items-center gap-4">
        <div
          className="w-16 h-16 rounded-xl overflow-hidden flex items-center justify-center shrink-0"
          style={{
            backgroundImage: "linear-gradient(45deg, #2a2730 25%, transparent 25%), linear-gradient(-45deg, #2a2730 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2a2730 75%), linear-gradient(-45deg, transparent 75%, #2a2730 75%)",
            backgroundSize: "10px 10px",
            backgroundPosition: "0 0, 0 5px, 5px -5px, -5px 0px",
            backgroundColor: "var(--ink-3)",
            border: "1px solid var(--line)",
          }}
        >
          {logoImage ? <img loading="lazy" src={logoImage} alt="Logo" className="w-full h-full object-contain p-1" /> : <Shirt size={22} color="rgba(243,239,230,0.4)" />}
        </div>
        <div className="flex flex-col gap-2">
          <label className="kulto-btn text-xs flex items-center gap-1 rounded-xl px-3 py-2 w-fit" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            <Upload size={14} /> Subir logo (PNG)
            <input type="file" accept="image/png" className="hidden" onChange={handleUpload} />
          </label>
          {logoImage && (
            <button onClick={() => setLogoImage(null)} className="kulto-btn text-xs" style={{ color: "var(--signal)" }}>Quitar logo</button>
          )}
        </div>
      </div>
      <div>
        <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Texto junto al logo (opcional)</label>
        <input
          value={logoText}
          onChange={(e) => setLogoText(e.target.value)}
          placeholder="Ej: KULTO"
          className="w-full rounded-xl p-3 text-sm"
          style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
        />
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Redes sociales</p>
        <div className="flex flex-col gap-2">
          <input
            value={socialInstagram}
            onChange={(e) => setSocialInstagram(e.target.value)}
            placeholder="Link de Instagram"
            className="w-full rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
          <input
            value={socialFacebook}
            onChange={(e) => setSocialFacebook(e.target.value)}
            placeholder="Link de Facebook (opcional)"
            className="w-full rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
          <input
            value={socialTiktok}
            onChange={(e) => setSocialTiktok(e.target.value)}
            placeholder="Link de TikTok (opcional)"
            className="w-full rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
        </div>
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid var(--line)" }}>
        <p className="text-sm font-semibold mb-2" style={{ color: "var(--bone)" }}>Datos de contacto formales</p>
        <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>Se muestran en el pie de página y en "¿Tienes dudas?", además del botón de WhatsApp que ya tenés.</p>
        <div className="flex flex-col gap-2">
          <input
            type="email"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="Mail de contacto"
            className="w-full rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
          <input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="Teléfono para mostrar (opcional, puede ser distinto al de WhatsApp)"
            className="w-full rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
          <input
            value={contactAddress}
            onChange={(e) => setContactAddress(e.target.value)}
            placeholder="Dirección (opcional)"
            className="w-full rounded-xl p-3 text-sm"
            style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
          />
        </div>
      </div>

      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

// Las fotos-paso que se ven debajo del título "Crea una prenda única" en el
// inicio (entre los banners) — cada una representa un paso a seguir para
// personalizar una prenda (ej: elegir la prenda, elegir el color, subir el
// diseño). Se suben tal cual, sin recorte forzado.
// Ventana flotante para reposicionar la foto de un paso dentro de la forma
// elegida (círculo, cuadrado, etc.), arrastrando la imagen directamente con
// el mouse o el dedo — como al elegir la foto de perfil en WhatsApp. Calcula
// el arrastre en base al tamaño real de la imagen para que lo que se ve acá
// sea exactamente lo que después queda en la web.
function ImageFocalPointModal({ image, shape, initialFocalX, initialFocalY, initialFocalZoom, onCancel, onSave }) {
  const MODAL_SIZE = 300;
  const ZOOM_MIN = 0.2, ZOOM_MAX = 4;
  const [focalX, setFocalX] = useState(initialFocalX ?? 50);
  const [focalY, setFocalY] = useState(initialFocalY ?? 50);
  const [zoom, setZoom] = useState(initialFocalZoom ?? 1);
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState(null); // { w, h }
  const dragRef = useRef(null); // { startX, startY, startFocalX, startFocalY, overflowW, overflowH }
  const box = howItWorksShapeBox(shape, MODAL_SIZE) || { width: MODAL_SIZE, height: MODAL_SIZE };

  const onImgLoad = (e) => {
    setNatural({ w: e.target.naturalWidth, h: e.target.naturalHeight });
  };

  // El "overflow" es cuánto se pasa la foto (ya agrandada por el zoom) del
  // tamaño de la caja — es lo que se puede recorrer arrastrando. Con zoom 1x
  // y una foto que ya llena justo la caja en un eje, ese eje no tiene margen
  // para arrastrar (por eso antes, con fotos chicas/cuadradas, el arrastre no
  // hacía nada — antes no había forma de agrandar la foto para poder mover).
  const computeOverflow = (z) => {
    const nat = natural;
    if (!nat || !nat.w || !nat.h) return { overflowW: 0, overflowH: 0 };
    const baseScale = Math.max(box.width / nat.w, box.height / nat.h);
    const scale = baseScale * (z ?? zoom);
    const dispW = nat.w * scale, dispH = nat.h * scale;
    return { overflowW: Math.max(0, dispW - box.width), overflowH: Math.max(0, dispH - box.height) };
  };

  const onPointerMove = (clientX, clientY) => {
    if (!dragRef.current) return;
    const { startX, startY, startFocalX, startFocalY, overflowW, overflowH } = dragRef.current;
    const dx = clientX - startX;
    const dy = clientY - startY;
    const nextX = overflowW > 0 ? Math.max(0, Math.min(100, startFocalX - (dx / overflowW) * 100)) : 50;
    const nextY = overflowH > 0 ? Math.max(0, Math.min(100, startFocalY - (dy / overflowH) * 100)) : 50;
    setFocalX(nextX);
    setFocalY(nextY);
  };

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragRef.current) return;
      e.preventDefault();
      const p = e.touches ? e.touches[0] : e;
      onPointerMove(p.clientX, p.clientY);
    };
    const handleUp = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchmove", handleMove, { passive: false });
    window.addEventListener("touchend", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
      window.removeEventListener("touchmove", handleMove);
      window.removeEventListener("touchend", handleUp);
    };
  });

  const startDrag = (e) => {
    e.preventDefault();
    const p = e.touches ? e.touches[0] : e;
    const { overflowW, overflowH } = computeOverflow();
    dragRef.current = { startX: p.clientX, startY: p.clientY, startFocalX: focalX, startFocalY: focalY, overflowW, overflowH };
    setDragging(true);
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.7)" }}>
      <div className="rounded-2xl p-5 flex flex-col gap-4 items-center" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", maxWidth: 360 }}>
        <div className="w-full flex items-center justify-between">
          <h4 className="font-semibold text-sm" style={{ color: "var(--bone)" }}>Ajustá la posición de la foto</h4>
          <button onClick={onCancel} className="kulto-btn p-1 rounded-full" style={{ color: "var(--slate)" }} aria-label="Cerrar"><X size={18} /></button>
        </div>
        <p className="text-xs text-center" style={{ color: "var(--slate)" }}>
          Arrastrá la foto con el mouse o el dedo, y usá el control de abajo para agrandarla o achicarla, hasta que quede como querés adentro de la forma.
        </p>
        <div
          className="relative overflow-hidden select-none"
          style={{ ...box, background: "#fff", cursor: dragging ? "grabbing" : "grab", touchAction: "none" }}
          onMouseDown={startDrag}
          onTouchStart={startDrag}
        >
          <img
            src={image}
            alt=""
            onLoad={onImgLoad}
            draggable={false}
            className="pointer-events-none"
            style={(() => {
              const nat = natural;
              if (!nat || !nat.w || !nat.h) return { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: `${focalX}% ${focalY}%` };
              const baseScale = Math.max(box.width / nat.w, box.height / nat.h);
              const scale = baseScale * zoom;
              const dispW = nat.w * scale, dispH = nat.h * scale;
              return { position: "absolute", width: dispW, height: dispH, left: focalOffset(dispW, box.width, focalX), top: focalOffset(dispH, box.height, focalY), maxWidth: "none" };
            })()}
          />
        </div>
        <div className="w-full flex items-center gap-2">
          <ZoomOut size={16} color="var(--slate)" />
          <input
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step="0.05"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1"
          />
          <ZoomIn size={16} color="var(--slate)" />
        </div>
        <div className="flex gap-2 w-full">
          <button onClick={() => { setFocalX(50); setFocalY(50); setZoom(1); }} className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            Centrar
          </button>
          <button onClick={onCancel} className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
            Cancelar
          </button>
          <button onClick={() => onSave(focalX, focalY, zoom)} className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold" style={{ background: "var(--signal)", color: "var(--bone)" }}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  );
}

function AdminHowItWorksSettings({ settings, onSave }) {
  const [steps, setSteps] = useState(settings.howItWorksSteps || []);
  const [saved, setSaved] = useState(false);
  const [posModalId, setPosModalId] = useState(null);

  useEffect(() => { setSteps(settings.howItWorksSteps || []); }, [settings]);

  const persist = async (next) => {
    setSteps(next);
    await onSave({ howItWorksSteps: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const saveCardSize = async (val) => {
    await onSave({ howItWorksCardSize: val });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const saveShape = async (val) => {
    await onSave({ howItWorksImageShape: val });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addStep = (file) => {
    if (!file) return;
    const isPng = file.type === "image/png";
    fileToBase64(file, (b64) => persist([...steps, { id: genId("step"), image: b64, caption: "" }]), 1200, 0.88, isPng ? "image/png" : "image/jpeg");
  };
  const removeStep = (id) => persist(steps.filter((s) => s.id !== id));
  const updateCaption = (id, caption) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, caption } : s)));
  // Cuando la forma recorta la foto (todo menos "Automática"), el admin puede
  // elegir qué parte de la foto queda centrada adentro de esa forma, para que
  // no se corte justo la parte importante (ej: los puntitos de color, las
  // letras de talla). Se guarda como foco en base 0-100 (como object-position).
  const updateFocal = (id, axis, value) => setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, [axis]: value } : s)));
  const saveFocal = (id, focalX, focalY, focalZoom) => {
    const next = steps.map((s) => (s.id === id ? { ...s, focalX, focalY, focalZoom } : s));
    setPosModalId(null);
    persist(next);
  };
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= steps.length) return;
    const next = [...steps];
    [next[i], next[j]] = [next[j], next[i]];
    persist(next);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-2xl" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>"Crea una prenda única" — pasos a seguir</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Se muestran debajo del título "Crea una prenda única" en el inicio, entre los banners. Subí una foto por cada paso (ej: elegir la prenda, elegir el color, subir el diseño) y agregale un texto corto si querés.
        </p>
      </div>
      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Tamaño de las tarjetas</label>
        <div className="flex gap-2">
          {[["sm", "Chico"], ["md", "Mediano"], ["lg", "Grande"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => saveCardSize(val)}
              className="kulto-btn flex-1 rounded-xl py-2 text-sm font-semibold"
              style={{ background: (settings.howItWorksCardSize || "md") === val ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Cambia el tamaño de las 3 tarjetas de una — siempre quedan todas iguales entre sí, sin importar cuánto texto tenga cada una.
        </p>
      </div>
      <div>
        <label className="text-xs mb-1 block" style={{ color: "var(--bone)" }}>Forma de las fotos</label>
        <div className="flex gap-2 flex-wrap">
          {[["auto", "Automática"], ["cuadrado", "Cuadrada"], ["circular", "Circular"], ["rectangular", "Rectangular"], ["triangular", "Triangular"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => saveShape(val)}
              className="kulto-btn rounded-xl px-3 py-2 text-sm font-semibold"
              style={{ background: (settings.howItWorksImageShape || "auto") === val ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          "Automática" respeta la proporción real de cada foto. Las demás recortan la foto para que entre en esa forma.
        </p>
      </div>
      {steps.length === 0 && <EmptyState text="Todavía no cargaste ningún paso." />}
      <div className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const shape = settings.howItWorksImageShape || "auto";
          const needsPosition = shape !== "auto" && !!s.image;
          const previewBox = howItWorksShapeBox(shape, 72);
          return (
            <div key={s.id} className="rounded-2xl p-3 flex flex-col gap-3" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1 shrink-0">
                  <button disabled={i === 0} onClick={() => move(i, -1)} className="kulto-btn p-1 rounded" style={{ color: i === 0 ? "var(--ink)" : "var(--bone)" }} aria-label="Subir paso"><ArrowUp size={14} /></button>
                  <button disabled={i === steps.length - 1} onClick={() => move(i, 1)} className="kulto-btn p-1 rounded" style={{ color: i === steps.length - 1 ? "var(--ink)" : "var(--bone)" }} aria-label="Bajar paso"><ArrowDown size={14} /></button>
                </div>
                <div className="w-14 h-14 rounded-xl overflow-hidden flex items-center justify-center shrink-0" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
                  {s.image ? <img loading="lazy" src={s.image} alt="" className="w-full h-full object-contain p-0.5" /> : <Shirt size={18} color="rgba(243,239,230,0.4)" />}
                </div>
                <input
                  placeholder={`Texto del paso ${i + 1} (opcional)`}
                  value={s.caption || ""}
                  onChange={(e) => updateCaption(s.id, e.target.value)}
                  onBlur={() => persist(steps)}
                  className="flex-1 min-w-0 rounded-xl p-2 text-sm"
                  style={{ background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
                />
                <button onClick={() => removeStep(s.id)} className="kulto-btn p-2 rounded-full" style={{ color: "var(--signal)" }} aria-label="Quitar paso"><Trash2 size={16} /></button>
              </div>
              {needsPosition && (
                <div className="flex items-center gap-4 pl-2 pt-2" style={{ borderTop: "1px solid var(--line)" }}>
                  <div className="shrink-0">
                    <FocalCropImage src={s.image} box={previewBox} focalX={s.focalX ?? 50} focalY={s.focalY ?? 50} zoom={s.focalZoom ?? 1} />
                  </div>
                  <button
                    onClick={() => setPosModalId(s.id)}
                    className="kulto-btn text-sm font-semibold px-3 py-2 rounded-xl flex items-center gap-2"
                    style={{ background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
                  >
                    <Move size={14} /> Ajustar posición y zoom
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2 w-fit" style={{ background: "var(--signal)", color: "var(--bone)" }}>
        <Upload size={16} /> Agregar paso
        <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { addStep(e.target.files[0]); e.target.value = ""; }} />
      </label>
      {saved && <p className="text-xs flex items-center gap-1" style={{ color: "var(--sun)" }}><Check size={12} /> Guardado</p>}
      {posModalId && (() => {
        const s = steps.find((x) => x.id === posModalId);
        if (!s) return null;
        return (
          <ImageFocalPointModal
            image={s.image}
            shape={settings.howItWorksImageShape || "auto"}
            initialFocalX={s.focalX ?? 50}
            initialFocalY={s.focalY ?? 50}
            initialFocalZoom={s.focalZoom ?? 1}
            onCancel={() => setPosModalId(null)}
            onSave={(fx, fy, fz) => saveFocal(s.id, fx, fy, fz)}
          />
        );
      })()}
    </div>
  );
}

// Los links que aparecen en el menú flotante "Productos" del header (junto a
// "Catálogo"), elegidos a mano por el admin — a propósito NO se arma solo
// listando todos los grupos/temáticas (esos se usan para los banners del
// inicio, son otra cosa). Cada link puede apuntar a un grupo o a una
// categoría ya creados.
function AdminProductsMenu({ items, categories, groups, onSave }) {
  const [list, setList] = useState(items || []);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setList(items || []); }, [items]);

  const persist = async (next) => {
    setList(next);
    await onSave({ productsMenuItems: next });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const addItem = () => {
    const firstType = groups.length ? "group" : "category";
    const firstValue = (firstType === "group" ? groups[0] : categories[0]) || "";
    persist([...list, { id: genId("pmi"), label: "", type: firstType, value: firstValue }]);
  };
  const updateItem = (id, patch) => setList((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const removeItem = (id) => persist(list.filter((it) => it.id !== id));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    persist(next);
  };

  const inputStyle = { background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-2xl" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Menú "Productos" del header</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Al lado de "Catálogo" en el menú flotante, agregá los accesos directos que quieras (ej: "Llaveros", "Lanyards"). Cada uno lleva al catálogo ya filtrado por la categoría o el grupo que elijas.
        </p>
      </div>
      {list.length === 0 && <EmptyState text="Por ahora el menú solo muestra 'Catálogo'." />}
      <div className="flex flex-col gap-3">
        {list.map((it, i) => (
          <div key={it.id} className="rounded-2xl p-3 flex flex-wrap items-center gap-2" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
            <div className="flex flex-col gap-1 shrink-0">
              <button disabled={i === 0} onClick={() => move(i, -1)} className="kulto-btn p-1 rounded" style={{ color: i === 0 ? "var(--ink)" : "var(--bone)" }} aria-label="Subir"><ArrowUp size={14} /></button>
              <button disabled={i === list.length - 1} onClick={() => move(i, 1)} className="kulto-btn p-1 rounded" style={{ color: i === list.length - 1 ? "var(--ink)" : "var(--bone)" }} aria-label="Bajar"><ArrowDown size={14} /></button>
            </div>
            <input
              placeholder="Texto a mostrar (ej: Llaveros)"
              value={it.label}
              onChange={(e) => updateItem(it.id, { label: e.target.value })}
              onBlur={() => persist(list)}
              className="rounded-xl p-2 text-sm flex-1 min-w-[140px]"
              style={inputStyle}
            />
            <select
              value={it.type}
              onChange={(e) => {
                const type = e.target.value;
                const value = (type === "group" ? groups[0] : categories[0]) || "";
                const next = list.map((x) => (x.id === it.id ? { ...x, type, value } : x));
                persist(next);
              }}
              className="rounded-xl p-2 text-sm"
              style={inputStyle}
            >
              <option value="category">Categoría</option>
              <option value="group">Grupo / temática</option>
            </select>
            <select
              value={it.value}
              onChange={(e) => persist(list.map((x) => (x.id === it.id ? { ...x, value: e.target.value } : x)))}
              className="rounded-xl p-2 text-sm flex-1 min-w-[140px]"
              style={inputStyle}
            >
              {(it.type === "group" ? groups : categories).map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <button onClick={() => removeItem(it.id)} className="kulto-btn p-2 rounded-full" style={{ color: "var(--signal)" }} aria-label="Quitar"><Trash2 size={16} /></button>
          </div>
        ))}
      </div>
      <button
        onClick={addItem}
        disabled={!categories.length && !groups.length}
        className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-2 w-fit"
        style={{ background: "var(--signal)", color: "var(--bone)", opacity: !categories.length && !groups.length ? 0.5 : 1 }}
      >
        <Plus size={16} /> Agregar acceso directo
      </button>
      {saved && <p className="text-xs flex items-center gap-1" style={{ color: "var(--sun)" }}><Check size={12} /> Guardado</p>}
    </div>
  );
}

function AdminSectionSettings({ settings, onSave }) {
  const [sections, setSections] = useState(getEffectiveHomeSections(settings));
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  useEffect(() => {
    setSections(getEffectiveHomeSections(settings));
  }, [settings]);

  const persist = (next) => {
    setSections(next);
    onSave({ homeSections: next });
  };

  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j], next[i]];
    persist(next);
  };

  const toggleVisible = (key) => {
    persist(sections.map((s) => (s.key === key ? { ...s, visible: s.visible === false } : s)));
  };

  const labelFor = (key) => {
    if (key.startsWith("banner:")) {
      const id = key.slice(7);
      const b = (settings.banners || []).find((x) => x.id === id);
      return b ? `Banner: ${b.title || "(sin título)"}` : "Banner (eliminado)";
    }
    return HOME_SECTION_DEFS.find((d) => d.key === key)?.label || key;
  };

  const sizeFor = (key) => {
    if (!key.startsWith("banner:")) return null;
    const id = key.slice(7);
    const b = (settings.banners || []).find((x) => x.id === id);
    return b?.size || "md";
  };

  const previewBarHeight = (key) => {
    const size = sizeFor(key);
    if (size === "sm") return 14;
    if (size === "lg") return 34;
    if (size === "md") return 22;
    return 18;
  };

  const handleDragStart = (i) => (e) => {
    setDragIndex(i);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleDragOver = (i) => (e) => {
    e.preventDefault();
    if (i !== overIndex) setOverIndex(i);
  };
  const handleDrop = (i) => (e) => {
    e.preventDefault();
    if (dragIndex === null || dragIndex === i) { setDragIndex(null); setOverIndex(null); return; }
    const next = [...sections];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(i, 0, moved);
    persist(next);
    setDragIndex(null);
    setOverIndex(null);
  };
  const handleDragEnd = () => { setDragIndex(null); setOverIndex(null); };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-3xl" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Secciones del inicio</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Arrastrá cada bloque desde el ícono (o usá las flechas) para cambiar el orden en que aparecen en la página de inicio, y ocultá los que no quieras mostrar por ahora, sin borrar nada. A la derecha vas viendo un esquema de cómo va quedando. Los banners que marcaste como "sección" en la pestaña de Banners también aparecen acá para que los ubiques donde quieras.
        </p>
      </div>
      <div className="grid md:grid-cols-[1fr_auto] gap-5 items-start">
        <div className="flex flex-col gap-2">
          {sections.map((s, i) => (
            <div
              key={s.key}
              draggable
              onDragStart={handleDragStart(i)}
              onDragOver={handleDragOver(i)}
              onDrop={handleDrop(i)}
              onDragEnd={handleDragEnd}
              className="rounded-xl p-3 flex items-center gap-3 cursor-move"
              style={{
                background: "var(--ink-3)",
                border: overIndex === i && dragIndex !== null && dragIndex !== i ? "1px dashed var(--signal)" : "1px solid var(--line)",
                opacity: s.visible === false ? 0.5 : dragIndex === i ? 0.4 : 1,
              }}
            >
              <GripVertical size={16} className="shrink-0" style={{ color: "var(--slate)" }} />
              <div className="flex flex-col gap-1 shrink-0">
                <button disabled={i === 0} onClick={() => move(i, -1)} className="kulto-btn p-1 rounded" style={{ color: i === 0 ? "var(--ink)" : "var(--bone)" }} aria-label="Subir sección"><ArrowUp size={14} /></button>
                <button disabled={i === sections.length - 1} onClick={() => move(i, 1)} className="kulto-btn p-1 rounded" style={{ color: i === sections.length - 1 ? "var(--ink)" : "var(--bone)" }} aria-label="Bajar sección"><ArrowDown size={14} /></button>
              </div>
              <p className="flex-1 text-sm font-semibold" style={{ color: "var(--bone)" }}>{labelFor(s.key)}</p>
              <button onClick={() => toggleVisible(s.key)} className="kulto-btn text-[11px] px-3 py-1.5 rounded-full font-semibold" style={{ background: s.visible === false ? "var(--ink)" : "var(--sun)", color: s.visible === false ? "var(--bone)" : "var(--ink)" }}>
                {s.visible === false ? "Mostrar" : "Ocultar"}
              </button>
            </div>
          ))}
        </div>

        <div className="rounded-xl p-3 w-full md:w-40 shrink-0" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
          <p className="text-[11px] font-semibold mb-2" style={{ color: "var(--slate)" }}>Vista previa</p>
          <div className="flex flex-col gap-1">
            <div className="rounded" style={{ height: 20, background: "var(--sun)", opacity: 0.9 }} title="Portada (arriba de todo)" />
            {sections.map((s) => (
              <div
                key={s.key}
                className="rounded"
                style={{
                  height: previewBarHeight(s.key),
                  background: s.key.startsWith("banner:") ? "var(--signal)" : "var(--bone)",
                  opacity: s.visible === false ? 0.25 : 0.85,
                }}
                title={labelFor(s.key)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminThemeSettings({ settings, onSave }) {
  const [theme, setTheme] = useState(settings.theme || DEFAULT_THEME);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setTheme(settings.theme || DEFAULT_THEME); }, [settings]);

  const fields = [
    { key: "ink", label: "Fondo principal (oscuro)" },
    { key: "bone", label: "Texto e íconos" },
    { key: "signal", label: "Acento principal (botones, ofertas)" },
    { key: "sun", label: "Acento secundario (precios, destacados)" },
    { key: "slate", label: "Texto secundario" },
  ];

  const save = async () => {
    await onSave({ theme });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setColor = (key, hex) => setTheme((t) => ({ ...t, [key]: hex }));
  const isValidHex = (v) => /^#[0-9A-Fa-f]{6}$/.test(v || "");

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Colores de la web</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Estos son los colores generales del sitio (no los colores de cada producto, que se cargan aparte en cada prenda). Podés pegar directamente el código hexadecimal (ej: #E8452C) en vez de buscarlo en el selector.
      </p>
      <div className="flex flex-col gap-3">
        {fields.map((f) => {
          const raw = theme[f.key] || "";
          const valid = isValidHex(raw);
          return (
            <div key={f.key} className="flex items-center gap-3">
              <input
                type="color"
                value={valid ? raw : "#000000"}
                onChange={(e) => setColor(f.key, e.target.value)}
                className="w-10 h-10 rounded shrink-0"
                style={{ background: "transparent" }}
              />
              <div className="flex-1">
                <p className="text-sm mb-1" style={{ color: "var(--bone)" }}>{f.label}</p>
                <input
                  type="text"
                  value={raw}
                  onChange={(e) => {
                    let v = e.target.value.trim();
                    if (v && !v.startsWith("#")) v = `#${v}`;
                    setColor(f.key, v);
                  }}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text").trim();
                    if (pasted) {
                      e.preventDefault();
                      setColor(f.key, pasted.startsWith("#") ? pasted : `#${pasted}`);
                    }
                  }}
                  placeholder="#RRGGBB"
                  spellCheck={false}
                  className="rounded-lg px-2 py-1.5 text-xs w-28 font-mono"
                  style={{ background: "var(--ink-3)", color: "var(--bone)", border: valid ? "1px solid var(--line)" : "1px solid var(--signal)" }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div>
        <p className="text-sm mb-2" style={{ color: "var(--bone)" }}>Sombra de las tarjetas de producto</p>
        <div className="flex gap-2 flex-wrap">
          {[
            { key: "ninguna", label: "Ninguna" },
            { key: "suave", label: "Suave" },
            { key: "media", label: "Media" },
            { key: "fuerte", label: "Fuerte" },
          ].map((o) => (
            <button
              key={o.key}
              onClick={() => setTheme((t) => ({ ...t, cardShadow: o.key }))}
              className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full"
              style={{
                background: (theme.cardShadow || "media") === o.key ? "var(--signal)" : "var(--ink-3)",
                color: "var(--bone)",
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button onClick={save} className="kulto-btn flex-1 rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
          {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
        </button>
        <button
          onClick={() => setTheme(DEFAULT_THEME)}
          className="kulto-btn rounded-full px-4 text-sm"
          style={{ background: "var(--ink-3)", color: "var(--bone)" }}
        >
          Restaurar
        </button>
      </div>
    </div>
  );
}

function AdminShippingSettings({ settings, onSave }) {
  const [flatRate, setFlatRate] = useState(settings.shippingFlatRate);
  const [threshold, setThreshold] = useState(settings.freeShippingThreshold);
  const [regionPrices, setRegionPrices] = useState(settings.shippingRegionPrices || {});
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setFlatRate(settings.shippingFlatRate);
    setThreshold(settings.freeShippingThreshold);
    setRegionPrices(settings.shippingRegionPrices || {});
  }, [settings]);

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const save = async () => {
    const cleanedRegionPrices = Object.fromEntries(
      SPAIN_REGIONS.map((region) => [region, Number(regionPrices[region]) || 0])
    );
    await onSave({
      shippingFlatRate: Number(flatRate) || 0,
      freeShippingThreshold: Number(threshold) || 0,
      shippingRegionPrices: cleanedRegionPrices,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Envío</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        El cliente puede elegir recoger en persona (sin costo) o pedir envío a domicilio, eligiendo su provincia. Cada provincia puede tener su propio precio de envío.
      </p>
      <div>
        <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Costo de envío por defecto (€)</label>
        <p className="text-xs mb-1" style={{ color: "var(--slate)" }}>Se usa solo como respaldo, si por algún motivo no hay un precio cargado para la provincia elegida.</p>
        <input type="number" step="0.5" value={flatRate} onChange={(e) => setFlatRate(e.target.value)} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
      </div>
      <div>
        <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Envío gratis a partir de (€)</label>
        <input type="number" step="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-full rounded-xl p-3 text-sm" style={inputStyle} />
      </div>
      <div>
        <p className="text-sm font-semibold mb-1" style={{ color: "var(--bone)" }}>Precio de envío por provincia / comunidad</p>
        <p className="text-xs mb-2" style={{ color: "var(--slate)" }}>
          Precargué valores de referencia para un paquete chico de ropa: en península suele salir lo mismo enviar a cualquier destino con un transportista de paquetería personal, mientras que Canarias, Ceuta y Melilla salen bastante más caros. Ajustá cada uno a lo que realmente te cobre tu transportista — por ejemplo, si a País Vasco te cobran distinto que a Madrid, cambiá solo esa fila.
        </p>
        <div className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1">
          {SPAIN_REGIONS.map((region) => (
            <div key={region} className="flex items-center gap-2">
              <span className="text-xs flex-1" style={{ color: "var(--bone)" }}>{region}</span>
              <input
                type="number" step="0.5" min="0"
                value={regionPrices[region] ?? ""}
                onChange={(e) => setRegionPrices((prev) => ({ ...prev, [region]: e.target.value }))}
                className="w-20 rounded-lg p-1.5 text-sm text-center"
                style={inputStyle}
              />
            </div>
          ))}
        </div>
      </div>
      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

function AdminDepositSettings({ settings, onSave }) {
  const [enabled, setEnabled] = useState(settings.depositEnabled);
  const [percent, setPercent] = useState(settings.depositPercent);
  const [info, setInfo] = useState(settings.depositInfo || "");
  const [serviceEnabled, setServiceEnabled] = useState(settings.designServiceEnabled ?? true);
  const [serviceFee, setServiceFee] = useState(settings.designServiceFee ?? 2);
  const [basePrice, setBasePrice] = useState(settings.personalizedBasePrice ?? 20);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setEnabled(settings.depositEnabled);
    setPercent(settings.depositPercent);
    setInfo(settings.depositInfo || "");
    setServiceEnabled(settings.designServiceEnabled ?? true);
    setServiceFee(settings.designServiceFee ?? 2);
    setBasePrice(settings.personalizedBasePrice ?? 20);
  }, [settings]);

  const save = async () => {
    await onSave({
      depositEnabled: enabled,
      depositPercent: Number(percent) || 0,
      depositInfo: info,
      designServiceEnabled: serviceEnabled,
      designServiceFee: Number(serviceFee) || 0,
      personalizedBasePrice: Number(basePrice) || 0,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Seña para pedidos personalizados</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Como una prenda personalizada no se puede revender si el cliente se arrepiente, le pedimos una parte del pago antes de empezar a producirla. Esto se suma solo a pedidos con diseño personalizado — el resto de la compra sigue igual.
      </p>
      <label className="flex items-center gap-2 text-sm" style={{ color: "var(--bone)" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Pedir seña en pedidos personalizados
      </label>
      {enabled && (
        <>
          <div>
            <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Porcentaje de seña</label>
            <div className="flex gap-2">
              {[30, 50, 100].map((p) => (
                <button
                  key={p}
                  onClick={() => setPercent(p)}
                  className="kulto-btn flex-1 text-sm font-semibold rounded-full py-2"
                  style={{ background: Number(percent) === p ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Cómo la reciben (se incluye en el mensaje)</label>
            <input
              value={info}
              onChange={(e) => setInfo(e.target.value)}
              placeholder="Ej: Bizum al +34662317094"
              className="w-full rounded-xl p-3 text-sm"
              style={inputStyle}
            />
          </div>
        </>
      )}
      <div className="pt-2" style={{ borderTop: "1px solid var(--line)" }}>
        <h4 className="font-semibold mb-1" style={{ color: "var(--bone)" }}>Tarifa fija para prendas personalizadas</h4>
        <p className="text-xs mb-3" style={{ color: "var(--slate)" }}>
          Este es el precio único que se cobra por cualquier prenda armada en "Personalizar" (remera, buzo, etc., sin importar cuál). La cambiás acá una sola vez y se aplica sola a todas — ya no hace falta poner un precio al cargar cada prenda base.
        </p>
        <div>
          <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Precio fijo (€)</label>
          <input
            type="number" min="0" step="0.5"
            value={basePrice}
            onChange={(e) => setBasePrice(e.target.value)}
            className="w-28 rounded-xl p-3 text-sm"
            style={inputStyle}
          />
        </div>
      </div>
      <div className="pt-2" style={{ borderTop: "1px solid var(--line)" }}>
        <h4 className="font-semibold mb-1" style={{ color: "var(--bone)" }}>Servicio "que le hagamos el diseño"</h4>
        <p className="text-xs mb-3" style={{ color: "var(--slate)" }}>
          En Personalizar, el cliente puede pedir que ustedes le hagan el diseño en vez de subir su propia imagen. Se suma este cargo y se aclara que lo coordinan por WhatsApp (con la seña de arriba, si está activada).
        </p>
        <label className="flex items-center gap-2 text-sm mb-3" style={{ color: "var(--bone)" }}>
          <input type="checkbox" checked={serviceEnabled} onChange={(e) => setServiceEnabled(e.target.checked)} />
          Ofrecer este servicio en Personalizar
        </label>
        {serviceEnabled && (
          <div>
            <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Cargo adicional (€)</label>
            <input
              type="number" min="0" step="0.5"
              value={serviceFee}
              onChange={(e) => setServiceFee(e.target.value)}
              className="w-28 rounded-xl p-3 text-sm"
              style={inputStyle}
            />
          </div>
        )}
      </div>
      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

// Guía de tamaños del diseño en Personalizar — el texto (y opcionalmente una
// imagen de referencia) que se muestra junto a la prenda en el paso 4, para
// que el cliente sepa de antemano qué tamaño aproximado va a tener su diseño
// adelante y atrás, y no se lleve una sorpresa ni reclame después.
function AdminPrintSizeGuideSettings({ settings, onSave }) {
  const [enabled, setEnabled] = useState(settings.printSizeGuideEnabled ?? true);
  const [frontText, setFrontText] = useState(settings.printSizeGuideFrontText || "");
  const [backText, setBackText] = useState(settings.printSizeGuideBackText || "");
  const [frontImage, setFrontImage] = useState(settings.printSizeGuideFrontImage || null);
  const [backImage, setBackImage] = useState(settings.printSizeGuideBackImage || null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setEnabled(settings.printSizeGuideEnabled ?? true);
    setFrontText(settings.printSizeGuideFrontText || "");
    setBackText(settings.printSizeGuideBackText || "");
    setFrontImage(settings.printSizeGuideFrontImage || null);
    setBackImage(settings.printSizeGuideBackImage || null);
  }, [settings]);

  const save = async () => {
    await onSave({
      printSizeGuideEnabled: enabled,
      printSizeGuideFrontText: frontText,
      printSizeGuideBackText: backText,
      printSizeGuideFrontImage: frontImage,
      printSizeGuideBackImage: backImage,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const zoneBlock = (label, text, setText, image, setImage) => (
    <div>
      <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>{label}</label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Ej: El diseño grande centrado mide entre 25 y 30 cm de ancho por 30 a 38 cm de alto..."
        className="w-full rounded-xl p-3 text-sm mb-2"
        style={inputStyle}
      />
      <div className="flex items-center gap-3">
        {image && (
          <img src={image} alt={label} className="w-16 h-20 object-cover rounded-lg" style={{ border: "1px solid var(--line)" }} />
        )}
        <label className="kulto-btn text-xs font-semibold rounded-xl px-3 py-2 cursor-pointer" style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}>
          {image ? "Cambiar imagen" : "Subir imagen (opcional)"}
          <input
            type="file" accept="image/png, image/jpeg" className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const isPng = f.type === "image/png";
              fileToBase64(f, (b64) => setImage(b64), 1200, isPng ? 1 : 0.88, isPng ? "image/png" : "image/jpeg");
            }}
          />
        </label>
        {image && (
          <button onClick={() => setImage(null)} className="kulto-btn text-xs" style={{ color: "var(--signal)" }}>Quitar</button>
        )}
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Guía de tamaños del diseño (Personalizar)</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Se muestra en el paso 4 de Personalizar, junto a la prenda, para aclarar qué tamaño aproximado va a tener el diseño adelante y atrás — así el cliente no se lleva una sorpresa cuando le llega el pedido. Podés poner el texto que quieras (por ejemplo, medidas estándar y a qué distancia del cuello queda) y, si querés, sumar una imagen de referencia para cada lado.
      </p>
      <label className="flex items-center gap-2 text-sm" style={{ color: "var(--bone)" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Mostrar esta guía en Personalizar
      </label>
      {enabled && (
        <>
          {zoneBlock("Adelante", frontText, setFrontText, frontImage, setFrontImage)}
          {zoneBlock("Atrás", backText, setBackText, backImage, setBackImage)}
        </>
      )}
      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

// Diagnóstico de mail: manda un mail de prueba real con sendEmail() (el mismo
// código que usan verificación de cuenta, recuperar contraseña y aviso de
// compra) para confirmar de una que RESEND_API_KEY está bien puesta en
// Vercel — sin tener que crear una cuenta de prueba o simular una compra.
function AdminEmailTestSettings({ settings }) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const sendTest = async () => {
    if (!email.trim()) return;
    setSending(true);
    setResult(null);
    const storeName = settings?.logoText || "Kulto";
    const res = await sendEmail({
      to: email.trim(),
      subject: `Mail de prueba de ${storeName}`,
      html: `<div style="font-family:sans-serif;padding:24px;"><h2>¡Funciona! 🎉</h2><p>Este es un mail de prueba desde el panel de administración de ${storeName}. Si te llegó, Resend está bien configurado y los mails de verificación, recuperar contraseña y confirmación de compra van a salir sin problema.</p></div>`,
    });
    setSending(false);
    setResult(res);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Probar el envío de mails</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Mandate un mail de prueba a vos mismo para confirmar que RESEND_API_KEY está bien configurada en Vercel. Es el mismo mecanismo que usan la verificación de cuenta, "olvidé mi contraseña" y el aviso de compra — si este mail te llega, esos también van a andar.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="tu-email@ejemplo.com"
          className="flex-1 rounded-xl p-3 text-sm min-w-[200px]"
          style={inputStyle}
        />
        <button
          onClick={sendTest}
          disabled={sending || !email.trim()}
          className="kulto-btn rounded-full px-4 py-3 font-semibold"
          style={{ background: "var(--signal)", color: "var(--bone)", opacity: sending || !email.trim() ? 0.6 : 1 }}
        >
          {sending ? "Enviando…" : "Enviar mail de prueba"}
        </button>
      </div>
      {result && result.ok && (
        <p className="text-xs font-semibold" style={{ color: "var(--sun)" }}>✓ Se mandó bien. Revisá tu bandeja de entrada (y la de spam, sobre todo si todavía no verificaste tu propio dominio en Resend).</p>
      )}
      {result && !result.ok && (
        <p className="text-xs font-semibold" style={{ color: "var(--signal)" }}>✗ No se pudo mandar: {result.error || "error desconocido"}. Si dice que falta RESEND_API_KEY, andá a Vercel → tu proyecto → Settings → Environment Variables y agregala (conseguí la clave gratis en resend.com), después hacé un redeploy.</p>
      )}
    </div>
  );
}

function AdminStoreTrustSettings({ settings, onSave }) {
  const [qualityEnabled, setQualityEnabled] = useState(settings.qualityPolicyEnabled ?? true);
  const [qualityText, setQualityText] = useState(settings.qualityPolicyText || "");
  const [productionTime, setProductionTime] = useState(settings.productionTimeNormal || "");
  const [returnsEnabled, setReturnsEnabled] = useState(settings.returnsPolicyEnabled ?? true);
  const [returnsText, setReturnsText] = useState(settings.returnsPolicyText || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setQualityEnabled(settings.qualityPolicyEnabled ?? true);
    setQualityText(settings.qualityPolicyText || "");
    setProductionTime(settings.productionTimeNormal || "");
    setReturnsEnabled(settings.returnsPolicyEnabled ?? true);
    setReturnsText(settings.returnsPolicyText || "");
  }, [settings]);

  const save = async () => {
    await onSave({
      qualityPolicyEnabled: qualityEnabled,
      qualityPolicyText: qualityText,
      productionTimeNormal: productionTime,
      returnsPolicyEnabled: returnsEnabled,
      returnsPolicyText: returnsText,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Confianza y tiempos</h4>

      <div>
        <label className="flex items-center gap-2 text-sm mb-2" style={{ color: "var(--bone)" }}>
          <input type="checkbox" checked={qualityEnabled} onChange={(e) => setQualityEnabled(e.target.checked)} />
          Mostrar política de calidad/reposición en la web
        </label>
        {qualityEnabled && (
          <textarea
            value={qualityText}
            onChange={(e) => setQualityText(e.target.value)}
            rows={2}
            placeholder="Ej: Reponemos sin cargo cualquier prenda con fallas de fabricación."
            className="w-full rounded-xl p-3 text-sm"
            style={inputStyle}
          />
        )}
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm mb-2" style={{ color: "var(--bone)" }}>
          <input type="checkbox" checked={returnsEnabled} onChange={(e) => setReturnsEnabled(e.target.checked)} />
          Mostrar política de cambios/devoluciones en el pie de página
        </label>
        {returnsEnabled && (
          <textarea
            value={returnsText}
            onChange={(e) => setReturnsText(e.target.value)}
            rows={3}
            placeholder="Ej: Tenés 10 días desde que recibís tu pedido para pedir un cambio o devolución."
            className="w-full rounded-xl p-3 text-sm"
            style={inputStyle}
          />
        )}
      </div>

      <div>
        <label className="text-sm mb-1 block" style={{ color: "var(--bone)" }}>Tiempo de producción para productos normales</label>
        <p className="text-xs mb-1" style={{ color: "var(--slate)" }}>Se muestra como destacado en catálogo y ficha de producto. Los pedidos personalizados ya avisan aparte que pueden tardar 3-7 días.</p>
        <input
          value={productionTime}
          onChange={(e) => setProductionTime(e.target.value)}
          placeholder="Ej: 3-5 días"
          className="w-full rounded-xl p-3 text-sm"
          style={inputStyle}
        />
      </div>

      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

function AdminFaqSettings({ settings, onSave }) {
  const [items, setItems] = useState(settings.faqItems || []);
  const [enabled, setEnabled] = useState(settings.faqEnabled ?? true);
  const [draft, setDraft] = useState({ question: "", answer: "" });
  const [editingId, setEditingId] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setItems(settings.faqItems || []);
    setEnabled(settings.faqEnabled ?? true);
  }, [settings]);

  const addOrUpdate = () => {
    if (!draft.question.trim() || !draft.answer.trim()) return;
    if (editingId) {
      setItems((prev) => prev.map((f) => (f.id === editingId ? { ...f, question: draft.question.trim(), answer: draft.answer.trim() } : f)));
      setEditingId(null);
    } else {
      setItems((prev) => [...prev, { id: genId("faq"), question: draft.question.trim(), answer: draft.answer.trim() }]);
    }
    setDraft({ question: "", answer: "" });
  };
  const editItem = (f) => { setDraft({ question: f.question, answer: f.answer }); setEditingId(f.id); };
  const cancelEdit = () => { setDraft({ question: "", answer: "" }); setEditingId(null); };
  const removeItem = (id) => {
    setItems((prev) => prev.filter((f) => f.id !== id));
    if (editingId === id) cancelEdit();
  };
  const move = (idx, dir) => {
    setItems((prev) => {
      const next = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const save = async () => {
    await onSave({ faqItems: items, faqEnabled: enabled });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Preguntas frecuentes</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>Se muestran como acordeón en el inicio de la web, nada más — no aparecen en el resto de las páginas.</p>

      <label className="flex items-center gap-2 text-sm" style={{ color: "var(--bone)" }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Mostrar preguntas frecuentes en el inicio
      </label>

      <div className="flex flex-col gap-2">
        {items.map((f, i) => (
          <div key={f.id} className="rounded-xl p-3 flex flex-col gap-1" style={{ background: "var(--ink-3)" }}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold flex-1" style={{ color: "var(--bone)" }}>{f.question}</p>
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="kulto-btn p-1" style={{ color: i === 0 ? "var(--slate)" : "var(--bone)" }} title="Subir"><ArrowUp size={14} /></button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1} className="kulto-btn p-1" style={{ color: i === items.length - 1 ? "var(--slate)" : "var(--bone)" }} title="Bajar"><ArrowDown size={14} /></button>
                <button onClick={() => editItem(f)} className="kulto-btn p-1" style={{ color: "var(--sun)" }} title="Editar"><Pencil size={14} /></button>
                <button onClick={() => removeItem(f.id)} className="kulto-btn p-1" style={{ color: "var(--signal)" }} title="Eliminar"><X size={14} /></button>
              </div>
            </div>
            <p className="text-xs" style={{ color: "var(--slate)" }}>{f.answer}</p>
          </div>
        ))}
        {items.length === 0 && <p className="text-xs" style={{ color: "var(--slate)" }}>No hay preguntas cargadas.</p>}
      </div>

      <div className="flex flex-col gap-2 pt-2" style={{ borderTop: "1px solid var(--line)" }}>
        <input
          value={draft.question}
          onChange={(e) => setDraft((d) => ({ ...d, question: e.target.value }))}
          placeholder="Pregunta"
          className="w-full rounded-xl p-2.5 text-sm"
          style={inputStyle}
        />
        <textarea
          value={draft.answer}
          onChange={(e) => setDraft((d) => ({ ...d, answer: e.target.value }))}
          rows={2}
          placeholder="Respuesta"
          className="w-full rounded-xl p-2.5 text-sm"
          style={inputStyle}
        />
        <div className="flex gap-2">
          <button onClick={addOrUpdate} className="kulto-btn flex-1 text-xs font-semibold rounded-xl px-3 py-2" style={{ background: "var(--sun)", color: "var(--ink)" }}>
            {editingId ? "Guardar cambios" : "Agregar pregunta"}
          </button>
          {editingId && (
            <button onClick={cancelEdit} className="kulto-btn text-xs px-3" style={{ color: "var(--slate)" }}>Cancelar</button>
          )}
        </div>
      </div>

      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

function AdminLoyaltySettings({ settings, onSave }) {
  const [signupEnabled, setSignupEnabled] = useState(settings.signupDiscountEnabled ?? true);
  const [signupPercent, setSignupPercent] = useState(settings.signupDiscountPercent ?? 10);
  const [loyaltyEnabled, setLoyaltyEnabled] = useState(settings.loyaltyEnabled ?? true);
  const [pointsPerItem, setPointsPerItem] = useState(settings.loyaltyPointsPerItem ?? 1);
  const [threshold, setThreshold] = useState(settings.loyaltyRewardThreshold ?? 5);
  const [rewardDesc, setRewardDesc] = useState(settings.loyaltyRewardDescription || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setSignupEnabled(settings.signupDiscountEnabled ?? true);
    setSignupPercent(settings.signupDiscountPercent ?? 10);
    setLoyaltyEnabled(settings.loyaltyEnabled ?? true);
    setPointsPerItem(settings.loyaltyPointsPerItem ?? 1);
    setThreshold(settings.loyaltyRewardThreshold ?? 5);
    setRewardDesc(settings.loyaltyRewardDescription || "");
  }, [settings]);

  const save = async () => {
    await onSave({
      signupDiscountEnabled: signupEnabled,
      signupDiscountPercent: Number(signupPercent) || 0,
      loyaltyEnabled,
      loyaltyPointsPerItem: Number(pointsPerItem) || 0,
      loyaltyRewardThreshold: Number(threshold) || 0,
      loyaltyRewardDescription: rewardDesc,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Cuentas, descuento y fidelidad</h4>

      <div>
        <label className="flex items-center gap-2 text-sm mb-2" style={{ color: "var(--bone)" }}>
          <input type="checkbox" checked={signupEnabled} onChange={(e) => setSignupEnabled(e.target.checked)} />
          Descuento por registrarse (primera compra)
        </label>
        {signupEnabled && (
          <div className="flex items-center gap-2">
            <input type="number" min="0" max="100" value={signupPercent} onChange={(e) => setSignupPercent(e.target.value)} className="w-20 rounded-xl p-2 text-sm" style={inputStyle} />
            <span className="text-sm" style={{ color: "var(--slate)" }}>% de descuento en su primer pedido</span>
          </div>
        )}
      </div>

      <div className="pt-2" style={{ borderTop: "1px solid var(--line)" }}>
        <label className="flex items-center gap-2 text-sm mb-2" style={{ color: "var(--bone)" }}>
          <input type="checkbox" checked={loyaltyEnabled} onChange={(e) => setLoyaltyEnabled(e.target.checked)} />
          Tarjeta de puntos por compras
        </label>
        {loyaltyEnabled && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input type="number" min="0" step="0.5" value={pointsPerItem} onChange={(e) => setPointsPerItem(e.target.value)} className="w-20 rounded-xl p-2 text-sm" style={inputStyle} />
              <span className="text-sm" style={{ color: "var(--slate)" }}>punto(s) por cada prenda comprada</span>
            </div>
            <div className="flex items-center gap-2">
              <input type="number" min="1" value={threshold} onChange={(e) => setThreshold(e.target.value)} className="w-20 rounded-xl p-2 text-sm" style={inputStyle} />
              <span className="text-sm" style={{ color: "var(--slate)" }}>puntos = 1 recompensa</span>
            </div>
            <input
              value={rewardDesc}
              onChange={(e) => setRewardDesc(e.target.value)}
              placeholder="Ej: Cada 5 prendas, la 6ta es gratis"
              className="w-full rounded-xl p-2 text-sm"
              style={inputStyle}
            />
            <p className="text-xs" style={{ color: "var(--slate)" }}>Esto es informativo para el cliente — vos decidís y aplicás la recompensa a mano desde la pestaña Clientes cuando alguien llega al umbral.</p>
          </div>
        )}
      </div>

      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

function AdminDesignFeedbackSettings({ settings, onSave }) {
  const [options, setOptions] = useState(settings.designFeedbackOptions || []);
  const [newOption, setNewOption] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => { setOptions(settings.designFeedbackOptions || []); }, [settings]);

  const addOption = () => {
    const v = newOption.trim();
    if (!v || options.includes(v)) return;
    setOptions((prev) => [...prev, v]);
    setNewOption("");
  };
  const removeOption = (v) => setOptions((prev) => prev.filter((o) => o !== v));

  const save = async () => {
    await onSave({ designFeedbackOptions: options });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4 max-w-md" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Opciones cuando el diseño no queda bien</h4>
      <p className="text-xs" style={{ color: "var(--slate)" }}>
        Si un cliente dice que su foto no quedó como quería, le mostramos estas opciones para elegir (además de un comentario libre).
      </p>
      <div className="flex flex-col gap-2">
        {options.map((o) => (
          <div key={o} className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: "var(--ink-3)" }}>
            <span className="flex-1 text-sm" style={{ color: "var(--bone)" }}>{o}</span>
            <button onClick={() => removeOption(o)} className="kulto-btn p-1" style={{ color: "var(--signal)" }}><X size={14} /></button>
          </div>
        ))}
        {options.length === 0 && <p className="text-xs" style={{ color: "var(--slate)" }}>No hay opciones cargadas.</p>}
      </div>
      <div className="flex gap-2">
        <input
          value={newOption}
          onChange={(e) => setNewOption(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addOption()}
          placeholder="Nueva opción"
          className="flex-1 rounded-xl p-2.5 text-sm"
          style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
        />
        <button onClick={addOption} className="kulto-btn text-xs font-semibold rounded-xl px-3" style={{ background: "var(--sun)", color: "var(--ink)" }}>Agregar</button>
      </div>
      <button onClick={save} className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2" style={{ background: saved ? "var(--sun)" : "var(--signal)", color: saved ? "var(--ink)" : "var(--bone)" }}>
        {saved ? <><Check size={16} /> Guardado</> : "Guardar"}
      </button>
    </div>
  );
}

// El formulario para cargar reseñas "a mano" (crear una desde cero) era
// solo para probar cómo se verían mientras se armaba la web — ya no está:
// acá solo se moderan las que realmente dejan los clientes.
function AdminReviews({ reviews, onSave, onDelete, onReorder }) {
  const pendingCount = reviews.filter((r) => r.status === "pendiente").length;

  const approve = (r) => onSave({ ...r, status: "aprobada" });

  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>
        Reseñas ({reviews.length}){pendingCount > 0 && <span style={{ color: "var(--signal)" }}> · {pendingCount} por aprobar</span>}
      </p>
      <p className="text-xs -mt-2" style={{ color: "var(--slate)" }}>El orden de esta lista es el orden en que se ven en la web. Estas son las que dejan los clientes desde "Seguir mi pedido".</p>
      {reviews.length === 0 && <EmptyState text="Todavía no hay ninguna reseña." />}
      {reviews.map((r, i) => (
        <div key={r.id} className="rounded-2xl p-3 flex items-start gap-3" style={{ background: "var(--ink-2)", border: r.status === "pendiente" ? "1px solid var(--signal)" : "1px solid var(--line)" }}>
          <div className="flex flex-col gap-1 shrink-0">
            <button disabled={i === 0} onClick={() => onReorder(r.id, -1)} className="kulto-btn p-1 rounded" style={{ color: i === 0 ? "var(--ink-3)" : "var(--bone)" }} aria-label="Subir reseña"><ArrowUp size={14} /></button>
            <button disabled={i === reviews.length - 1} onClick={() => onReorder(r.id, 1)} className="kulto-btn p-1 rounded" style={{ color: i === reviews.length - 1 ? "var(--ink-3)" : "var(--bone)" }} aria-label="Bajar reseña"><ArrowDown size={14} /></button>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>{r.name}</p>
              <StarRow rating={r.rating} />
            </div>
            {r.items?.length > 0 && <p className="text-xs mt-0.5" style={{ color: "var(--sun)" }}>Compró: {r.items.join(", ")}</p>}
            <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>{r.text}</p>
            {r.photo && <img loading="lazy" src={r.photo} className="w-16 h-16 rounded-lg object-cover mt-2" alt="Foto de la reseña" />}
            {r.status === "pendiente" && (
              <button onClick={() => approve(r)} className="kulto-btn text-xs font-semibold mt-2 px-3 py-1 rounded-full" style={{ background: "var(--sun)", color: "var(--ink)" }}>
                Aprobar y publicar
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1 shrink-0">
            <button onClick={() => { if (window.confirm(`¿Borrar la reseña de "${r.name}"? Esta acción no se puede deshacer.`)) onDelete(r.id); }} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--signal)" }} aria-label="Borrar reseña"><Trash2 size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

// Mensajes que llegaron por el formulario de "Contacto" — acá el admin ve
// cada uno, puede marcarlo resuelto o no, aprobar o rechazar un cambio o
// devolución pedido, regalar un % de descuento para la próxima compra (le
// genera un código), y responder por mail directo desde el panel.
function AdminContactMessages({ messages, onUpdate, onDelete, onReply }) {
  const [openId, setOpenId] = useState(null);
  const [replyDrafts, setReplyDrafts] = useState({});
  const [discountDrafts, setDiscountDrafts] = useState({});
  const [sendingId, setSendingId] = useState(null);
  const [sentId, setSentId] = useState(null);

  const pendingCount = messages.filter((m) => m.status !== "resuelto").length;
  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id));
  const setStatus = (m, status) => onUpdate({ ...m, status });
  const setDecision = (m, changeDecision) => onUpdate({ ...m, changeDecision });

  const applyDiscount = (m) => {
    const percent = Number(discountDrafts[m.id]);
    if (!percent || percent <= 0) return;
    onUpdate({ ...m, discountPercent: percent, discountCode: genDiscountCode(percent) });
  };
  const removeDiscount = (m) => onUpdate({ ...m, discountPercent: null, discountCode: null });

  const sendReply = async (m) => {
    const text = (replyDrafts[m.id] || "").trim();
    if (!text) return;
    setSendingId(m.id);
    const result = await onReply(m, text);
    setSendingId(null);
    if (result?.ok) {
      setSentId(m.id);
      setReplyDrafts((d) => ({ ...d, [m.id]: "" }));
      setTimeout(() => setSentId(null), 2000);
    }
  };

  const inputStyle = { background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="flex flex-col gap-3 max-w-2xl">
      <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>
        Mensajes de contacto ({messages.length}){pendingCount > 0 && <span style={{ color: "var(--signal)" }}> · {pendingCount} pendientes</span>}
      </p>
      <p className="text-xs -mt-2" style={{ color: "var(--slate)" }}>Estos son los mensajes que dejan los clientes desde el botón "Contacto" del sitio.</p>
      {messages.length === 0 && <EmptyState text="Todavía no llegó ningún mensaje por el formulario de contacto." />}
      {messages.map((m) => {
        const isOpen = openId === m.id;
        return (
          <div key={m.id} className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: "var(--ink-2)", border: m.status !== "resuelto" ? "1px solid var(--signal)" : "1px solid var(--line)" }}>
            <button onClick={() => toggle(m.id)} className="kulto-btn flex items-start justify-between gap-3 text-left">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "var(--bone)" }}>
                  {m.name} <span className="font-normal" style={{ color: "var(--slate)" }}>· {m.subject}</span>
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--slate)" }}>{m.email} · {new Date(m.createdAt).toLocaleString("es-ES")}</p>
              </div>
              <span className="text-[10px] font-semibold px-2 py-1 rounded-full shrink-0" style={{ background: m.status === "resuelto" ? "var(--ink-3)" : "var(--signal)", color: m.status === "resuelto" ? "var(--slate)" : "var(--bone)" }}>
                {m.status === "resuelto" ? "Resuelto" : "Pendiente"}
              </span>
            </button>
            {isOpen && (
              <div className="flex flex-col gap-4 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
                <p className="text-sm whitespace-pre-line" style={{ color: "var(--bone)" }}>{m.message}</p>

                <div>
                  <p className="text-xs mb-1.5" style={{ color: "var(--slate)" }}>Estado</p>
                  <div className="flex gap-2">
                    <button onClick={() => setStatus(m, "pendiente")} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: m.status !== "resuelto" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}>Pendiente</button>
                    <button onClick={() => setStatus(m, "resuelto")} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: m.status === "resuelto" ? "var(--sun)" : "var(--ink-3)", color: m.status === "resuelto" ? "var(--ink)" : "var(--bone)" }}>Resuelto</button>
                  </div>
                </div>

                <div>
                  <p className="text-xs mb-1.5" style={{ color: "var(--slate)" }}>Cambio / devolución pedido</p>
                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => setDecision(m, "")} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: !m.changeDecision ? "var(--ink)" : "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}>Sin definir</button>
                    <button onClick={() => setDecision(m, "aprobado")} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: m.changeDecision === "aprobado" ? "var(--sun)" : "var(--ink-3)", color: m.changeDecision === "aprobado" ? "var(--ink)" : "var(--bone)" }}>Aprobado</button>
                    <button onClick={() => setDecision(m, "rechazado")} className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background: m.changeDecision === "rechazado" ? "var(--signal)" : "var(--ink-3)", color: "var(--bone)" }}>Rechazado</button>
                  </div>
                </div>

                <div>
                  <p className="text-xs mb-1.5" style={{ color: "var(--slate)" }}>Descuento de regalo para su próxima compra</p>
                  {m.discountPercent ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold" style={{ color: "var(--sun)" }}>{m.discountPercent}% — código {m.discountCode}</span>
                      <button onClick={() => removeDiscount(m)} className="kulto-btn text-xs" style={{ color: "var(--signal)" }}>Quitar</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <input
                        type="number" min="1" max="100" placeholder="%"
                        value={discountDrafts[m.id] || ""}
                        onChange={(e) => setDiscountDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                        className="rounded-lg p-2 text-sm w-20"
                        style={inputStyle}
                      />
                      <button onClick={() => applyDiscount(m)} className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>Regalar descuento</button>
                    </div>
                  )}
                  {m.discountPercent && (
                    <p className="text-[11px] mt-1" style={{ color: "var(--slate)" }}>Es un código para mencionar cuando haga su próximo pedido — como acá el pedido se cierra por WhatsApp, se lo aplicás vos a mano en ese momento.</p>
                  )}
                </div>

                <div>
                  <p className="text-xs mb-1.5" style={{ color: "var(--slate)" }}>Responder por mail</p>
                  <textarea
                    placeholder="Escribí tu respuesta..."
                    value={replyDrafts[m.id] || ""}
                    onChange={(e) => setReplyDrafts((d) => ({ ...d, [m.id]: e.target.value }))}
                    rows={3}
                    className="w-full rounded-xl p-2.5 text-sm resize-none"
                    style={inputStyle}
                  />
                  <button
                    onClick={() => sendReply(m)}
                    disabled={sendingId === m.id || !(replyDrafts[m.id] || "").trim()}
                    className="kulto-btn text-sm font-semibold px-4 py-2 rounded-full mt-2 flex items-center gap-2"
                    style={{ background: sentId === m.id ? "var(--sun)" : "var(--signal)", color: sentId === m.id ? "var(--ink)" : "var(--bone)", opacity: sendingId === m.id ? 0.7 : 1 }}
                  >
                    {sendingId === m.id ? <><Loader2 size={14} className="animate-spin" /> Enviando…</> : sentId === m.id ? <><Check size={14} /> Enviado</> : "Enviar respuesta"}
                  </button>
                  {m.adminReply && (
                    <p className="text-[11px] mt-1.5" style={{ color: "var(--slate)" }}>
                      Última respuesta enviada{m.repliedAt ? ` el ${new Date(m.repliedAt).toLocaleString("es-ES")}` : ""}.
                    </p>
                  )}
                </div>

                <button
                  onClick={() => { if (window.confirm(`¿Borrar el mensaje de "${m.name}"?`)) onDelete(m.id); }}
                  className="kulto-btn text-xs font-semibold flex items-center gap-1.5 w-fit"
                  style={{ color: "var(--signal)" }}
                >
                  <Trash2 size={13} /> Borrar mensaje
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// La tarjeta de cada categoría (ej: "Camisetas") en el paso 1 de
// "Personalizar" necesitaba una foto propia, elegida por el admin — antes se
// tomaba automáticamente de cualquiera de los modelos de adentro (Oversize,
// Beagle, etc.), sin forma de elegirla. Esto deja subir una foto
// independiente por categoría, que se usa tal cual (o la automática si no se
// cargó ninguna).
function AdminPersonalizeGroupImages({ templateProducts = [], settings, onSave }) {
  const groupNames = Array.from(new Set(templateProducts.map((p) => p.category).filter(Boolean)));
  const covers = settings.personalizeGroupCovers || {};
  const [savedGroup, setSavedGroup] = useState(null);

  const upload = (group, file) => {
    if (!file) return;
    const isPng = file.type === "image/png";
    fileToBase64(file, async (b64) => {
      await onSave({ personalizeGroupCovers: { ...covers, [group]: b64 } });
      setSavedGroup(group);
      setTimeout(() => setSavedGroup(null), 1500);
    }, 1200, 0.88, isPng ? "image/png" : "image/jpeg");
  };
  const remove = async (group) => {
    const next = { ...covers };
    delete next[group];
    await onSave({ personalizeGroupCovers: next });
  };

  if (!groupNames.length) return null;

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Foto de cada categoría en "Personalizar"</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Es la foto que ve el cliente en el paso 1, al elegir qué quiere personalizar (ej: "Camisetas") — independiente de las fotos de los modelos que hay adentro (Oversize, Beagle, etc.). Si no subís una acá, se usa automáticamente una foto de alguno de esos modelos.
        </p>
      </div>
      <div className="flex flex-wrap gap-4">
        {groupNames.map((g) => {
          const sample = templateProducts.find((p) => p.category === g);
          const fallback = sample?.colors?.[0]?.frontImage || sample?.colors?.[0]?.images?.[0];
          const img = covers[g] || null;
          return (
            <div key={g} className="flex flex-col items-center gap-1.5">
              <div className="relative w-20 h-24 rounded-xl overflow-hidden flex items-center justify-center" style={{ background: "var(--ink-3)", border: img ? "2px solid var(--sun)" : "1px solid var(--line)" }}>
                {(img || fallback) ? (
                  <img loading="lazy" src={img || fallback} className="w-full h-full object-contain p-1" alt={g} />
                ) : (
                  <Shirt size={20} color="rgba(243,239,230,0.4)" />
                )}
                {!img && fallback && (
                  <span className="absolute bottom-0 left-0 right-0 text-[8px] text-center py-0.5" style={{ background: "rgba(21,19,26,0.8)", color: "var(--slate)" }}>Automática</span>
                )}
              </div>
              <span className="text-xs font-semibold text-center max-w-[80px] truncate" style={{ color: "var(--bone)" }}>{g}</span>
              <div className="flex items-center gap-2">
                <label className="kulto-btn text-[10px] px-2 py-1 rounded-full cursor-pointer" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                  {img ? "Cambiar" : "Elegir"}
                  <input type="file" accept="image/png,image/jpeg" className="hidden" onChange={(e) => { upload(g, e.target.files[0]); e.target.value = ""; }} />
                </label>
                {img && <button onClick={() => remove(g)} className="kulto-btn text-[10px]" style={{ color: "var(--signal)" }}>Quitar</button>}
              </div>
              {savedGroup === g && <span className="text-[10px]" style={{ color: "var(--sun)" }}>Guardado ✓</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Precio por subcategoría/estilo (Beagle, Oversize, Vendetta, Chow, etc.) para
// usar en "Personalizar" en vez de tener que ponerle precio a cada prenda base
// una por una. Las subcategorías aparecen solas a medida que se cargan prendas
// base con ese campo completado.
function AdminPersonalizeSubcategoryPrices({ templateProducts = [], settings, onSave }) {
  const subcategories = Array.from(new Set(templateProducts.map((p) => p.subcategory).filter(Boolean)));
  const prices = settings.personalizeSubcategoryPrices || {};
  const [drafts, setDrafts] = useState({});
  const [savedSub, setSavedSub] = useState(null);

  useEffect(() => { setDrafts({}); }, [templateProducts.length]);

  const valueFor = (sub) => drafts[sub] !== undefined ? drafts[sub] : (prices[sub] != null ? prices[sub] : "");

  const save = async (sub) => {
    const raw = drafts[sub];
    const next = { ...prices };
    if (raw === "" || raw == null) {
      delete next[sub];
    } else {
      next[sub] = Number(raw) || 0;
    }
    await onSave({ personalizeSubcategoryPrices: next });
    setSavedSub(sub);
    setTimeout(() => setSavedSub(null), 1500);
  };

  if (!subcategories.length) return null;

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Precios por estilo en "Personalizar"</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Ponele un precio a cada estilo de prenda (Beagle, Oversize, Vendetta, Chow, etc.) — así podés vender el mismo diseño en varios estilos a distinto precio, sin tener que poner precio prenda por prenda. Si dejás uno vacío, se usa el precio general de Personalizar.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {subcategories.map((sub) => (
          <div key={sub} className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold min-w-[100px]" style={{ color: "var(--bone)" }}>{sub}</span>
            <div className="flex items-center gap-1">
              <span className="text-xs" style={{ color: "var(--slate)" }}>$</span>
              <input
                type="number"
                min="0"
                step="0.01"
                placeholder={String(settings.personalizedBasePrice ?? 20)}
                value={valueFor(sub)}
                onChange={(e) => setDrafts((d) => ({ ...d, [sub]: e.target.value }))}
                onBlur={() => save(sub)}
                className="text-sm rounded-lg px-2 py-1 w-24"
                style={inputStyle}
              />
            </div>
            {savedSub === sub && <span className="text-[10px]" style={{ color: "var(--sun)" }}>Guardado ✓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Chiquito bloque de 4 casilleros que arma la "portada" de una carpeta de
// diseños — lo que se ve de afuera de la tarjeta, elegido a mano por el
// admin (coverDesignIds), sin tener que entrar a la carpeta.
function FolderCoverThumb({ coverDesignIds = [], allDesigns, size = 64 }) {
  const imgs = coverDesignIds.map((id) => allDesigns.find((d) => d.id === id)).filter(Boolean).slice(0, 4);
  return (
    <div className="grid grid-cols-2 gap-0.5 rounded-lg overflow-hidden shrink-0" style={{ width: size, height: size, background: "var(--ink)" }}>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-center justify-center overflow-hidden" style={{ background: "var(--ink-2)" }}>
          {imgs[i] ? <img loading="lazy" src={imgs[i].image} className="w-full h-full object-cover" alt="" /> : null}
        </div>
      ))}
    </div>
  );
}

// Librería general de diseños propios (PNG) que el cliente puede elegir y
// posicionar en cualquier prenda dentro de Personalizar — no depende de un
// producto en particular. Se pueden agrupar en carpetas (opcional) para no
// mostrar todo en una sola grilla gigante — cada carpeta muestra de afuera
// hasta 4 diseños "portada" que el admin elige a mano. Una carpeta puede
// además quedar atada a una categoría de producto (ej: "Mates"): en ese caso
// sus diseños solo aparecen al personalizar esa categoría; si se deja en
// "Todas", se ven siempre sin importar qué prenda se esté personalizando.
function AdminDesignLibrary({ designs, onAdd, onRemove, folders = [], categories = [], onAddFolder, onRenameFolder, onRemoveFolder, onToggleCover, onAssignFolder, onSetFolderCategory }) {
  const [name, setName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderCategory, setNewFolderCategory] = useState("");
  const [openFolderId, setOpenFolderId] = useState(null);
  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const handleFiles = async (fileList) => {
    // Al subir una carpeta entera del sistema (ver "Subir carpeta" abajo)
    // pueden colarse archivos que no son imágenes — se ignoran solos, sin
    // frenar la carga del resto.
    const files = Array.from(fileList || []).filter((f) => f.type === "image/png" || f.type === "image/jpeg");
    setUploading(true);
    setError("");
    let failed = 0;
    let lastError = "";
    for (const file of files) {
      const isPng = file.type === "image/png";
      // Un poco más chico que otras fotos del sitio — un diseño no necesita
      // tanta resolución para verse bien puesto sobre una prenda, y así pesa
      // menos y es menos probable que falle al guardarlo.
      const b64 = await new Promise((resolve) => fileToBase64(file, resolve, 1000, isPng ? 1 : 0.9, isPng ? "image/png" : "image/jpeg"));
      const baseName = files.length > 1 ? file.name.replace(/\.[^.]+$/, "") : (name.trim() || file.name.replace(/\.[^.]+$/, ""));
      const result = await onAdd({ id: genId("d"), name: baseName, image: b64, folderId: openFolderId || null });
      if (!result.ok) { failed += 1; lastError = result.error || ""; }
    }
    setUploading(false);
    setName("");
    if (failed > 0) {
      const base =
        failed === files.length
          ? "No se pudo guardar ningún diseño."
          : `${failed} de ${files.length} diseños no se pudieron guardar.`;
      setError(lastError ? `${base} Motivo: ${lastError}` : `${base} Revisá tu conexión a internet e intentá de nuevo — si sigue fallando, puede ser que falte configurar Supabase en el proyecto (ver README).`);
    }
  };

  const createFolder = () => {
    if (!newFolderName.trim()) return;
    onAddFolder(newFolderName.trim(), newFolderCategory);
    setNewFolderName("");
    setNewFolderCategory("");
  };

  const openFolder = folders.find((f) => f.id === openFolderId) || null;
  const designsInOpenFolder = openFolder ? designs.filter((d) => d.folderId === openFolder.id) : [];

  const renderDesign = (d) => (
    <div key={d.id} className="flex flex-col items-center gap-1">
      <div className="w-16 h-16 rounded-lg overflow-hidden flex items-center justify-center relative" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
        <img loading="lazy" src={d.image} className="w-full h-full object-contain" alt={d.name} />
        {openFolder && (
          <button
            onClick={() => onToggleCover(openFolder.id, d.id)}
            className="kulto-btn absolute top-0.5 right-0.5 p-0.5 rounded-full"
            title={(openFolder.coverDesignIds || []).includes(d.id) ? "Quitar de la portada" : "Poner en la portada"}
            style={{ background: "rgba(21,19,26,0.75)" }}
          >
            <Star size={12} color={(openFolder.coverDesignIds || []).includes(d.id) ? "var(--sun)" : "var(--bone)"} fill={(openFolder.coverDesignIds || []).includes(d.id) ? "var(--sun)" : "none"} />
          </button>
        )}
      </div>
      <span className="text-[10px] text-center max-w-[64px] truncate" style={{ color: "var(--slate)" }}>{d.name}</span>
      {folders.length > 0 && (
        <select
          value={d.folderId || ""}
          onChange={(e) => onAssignFolder(d.id, e.target.value || null)}
          className="text-[10px] rounded px-1 py-0.5 max-w-[70px]"
          style={inputStyle}
        >
          <option value="">Sin carpeta</option>
          {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      )}
      <button onClick={() => onRemove(d.id)} className="kulto-btn" style={{ color: "var(--signal)" }} title="Quitar de la librería"><Trash2 size={12} /></button>
    </div>
  );

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Diseños propios de Kulto</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Subí tus diseños en PNG acá una sola vez. Van a aparecer en Personalizar para que el cliente los elija y los ubique en la prenda que quiera, adelante o atrás. Si tenés muchos, agrupalos en carpetas — y si le asignás una categoría a la carpeta (ej: "Mates"), esos diseños van a aparecer solo cuando el cliente esté personalizando esa categoría, en vez de en todas.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input placeholder="Nombre del diseño (opcional, si subís uno solo)" value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl p-2 text-sm flex-1 min-w-[160px]" style={inputStyle} />
        <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2 shrink-0" style={{ background: uploading ? "var(--ink-3)" : "var(--signal)", color: "var(--bone)" }}>
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} {uploading ? "Subiendo…" : "Subir PNG"}
          <input type="file" accept="image/png" multiple className="hidden" disabled={uploading} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
        </label>
        <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2 shrink-0" style={{ background: uploading ? "var(--ink-3)" : "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}>
          <FolderPlus size={16} /> Subir carpeta
          <input
            type="file"
            webkitdirectory=""
            directory=""
            multiple
            className="hidden"
            disabled={uploading}
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }}
          />
        </label>
      </div>
      <p className="text-xs -mt-2" style={{ color: "var(--slate)" }}>
        "Subir carpeta" te deja elegir una carpeta entera de tu compu y sube de una todas las imágenes que tenga adentro (ignora lo que no sea foto).
      </p>
      {openFolder && (
        <p className="text-xs" style={{ color: "var(--slate)" }}>Lo que subas acá va a entrar directo en la carpeta "{openFolder.name}".</p>
      )}
      {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}

      <div className="flex flex-wrap items-center gap-2 pt-3" style={{ borderTop: "1px solid var(--line)" }}>
        <input
          placeholder="Nombre de la carpeta (ej: Anime, Música, Coches)"
          value={newFolderName}
          onChange={(e) => setNewFolderName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") createFolder(); }}
          className="rounded-xl p-2 text-sm flex-1 min-w-[160px]"
          style={inputStyle}
        />
        <select
          value={newFolderCategory}
          onChange={(e) => setNewFolderCategory(e.target.value)}
          className="rounded-xl p-2 text-sm"
          style={inputStyle}
          title="A qué categoría de producto quedan atados los diseños de esta carpeta"
        >
          <option value="">Todas las categorías</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={createFolder} className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full flex items-center gap-2 shrink-0" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
          <FolderPlus size={16} /> Nueva carpeta
        </button>
      </div>

      {designs.length === 0 && folders.length === 0 ? (
        <EmptyState text="Todavía no subiste diseños a la librería." />
      ) : openFolder ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setOpenFolderId(null)} className="kulto-btn text-sm font-semibold flex items-center gap-1 shrink-0" style={{ color: "var(--slate)" }}>
              <ArrowLeft size={14} /> Carpetas
            </button>
            <input
              value={openFolder.name}
              onChange={(e) => onRenameFolder(openFolder.id, e.target.value)}
              className="rounded-xl p-2 text-sm flex-1 min-w-[120px]"
              style={inputStyle}
            />
            <button
              onClick={() => {
                if (window.confirm(`¿Borrar la carpeta "${openFolder.name}"? Los diseños de adentro no se borran, quedan sueltos.`)) {
                  onRemoveFolder(openFolder.id);
                  setOpenFolderId(null);
                }
              }}
              className="kulto-btn p-2 rounded-full shrink-0"
              style={{ color: "var(--signal)" }}
              aria-label="Borrar carpeta"
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs shrink-0" style={{ color: "var(--slate)" }}>Categoría de esta carpeta:</label>
            <select
              value={openFolder.category || ""}
              onChange={(e) => onSetFolderCategory(openFolder.id, e.target.value)}
              className="rounded-xl p-2 text-sm flex-1 min-w-[140px]"
              style={inputStyle}
            >
              <option value="">Todas las categorías</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <p className="text-xs" style={{ color: "var(--slate)" }}>
            {openFolder.category
              ? `Estos diseños solo van a aparecer al personalizar productos de la categoría "${openFolder.category}".`
              : "Sin categoría asignada: estos diseños se ven siempre, sin importar qué producto esté personalizando el cliente."}
          </p>
          <p className="text-xs" style={{ color: "var(--slate)" }}>
            Tocá la estrella de hasta 4 diseños para elegir la portada de esta carpeta — es lo que se ve de afuera, sin entrar.
          </p>
          {designsInOpenFolder.length === 0 ? (
            <EmptyState text="Esta carpeta todavía no tiene diseños — subí uno nuevo arriba, o asignale uno ya existente desde 'Todos los diseños'." />
          ) : (
            <div className="flex flex-wrap gap-3">{designsInOpenFolder.map(renderDesign)}</div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {folders.length > 0 && (
            <div>
              <p className="text-xs font-semibold mb-2" style={{ color: "var(--bone)" }}>Carpetas</p>
              <div className="flex flex-wrap gap-3">
                {folders.map((f) => {
                  const count = designs.filter((d) => d.folderId === f.id).length;
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setOpenFolderId(f.id)}
                      className="kulto-btn flex flex-col items-center gap-1.5 rounded-xl p-2"
                      style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}
                    >
                      <FolderCoverThumb coverDesignIds={f.coverDesignIds || []} allDesigns={designs} />
                      <span className="text-xs font-semibold max-w-[80px] truncate" style={{ color: "var(--bone)" }}>{f.name}</span>
                      <span className="text-[10px]" style={{ color: "var(--slate)" }}>{count} diseño{count === 1 ? "" : "s"}</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full max-w-[80px] truncate" style={{ background: f.category ? "var(--sun)" : "var(--ink)", color: f.category ? "var(--ink)" : "var(--slate)" }}>
                        {f.category || "Todas"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div>
            {folders.length > 0 && <p className="text-xs font-semibold mb-2" style={{ color: "var(--bone)" }}>Todos los diseños</p>}
            {designs.length === 0 ? (
              <EmptyState text="Todavía no subiste diseños a la librería." />
            ) : (
              <div className="flex flex-wrap gap-3">{designs.map(renderDesign)}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Galería de fotos de "trabajos personalizados" (pedidos reales ya hechos)
// para mostrar en el inicio, cerca de "Personalizar" — misma lógica que la
// librería de diseños de arriba: subida múltiple, con una leyenda opcional
// por foto (ej: "Remera oversize a pedido de @usuario").
const CUSTOMWORK_SPEED_MIN = 0.1;
const CUSTOMWORK_SPEED_MAX = 2;

function AdminCustomWorkGallery({ items, onAdd, onRemove, speed = 0.5, onSpeedChange }) {
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  // Valor local para que la barra se sienta fluida al arrastrarla — recién se
  // guarda cuando se suelta, para no mandar un guardado por cada pixel movido.
  const [speedDraft, setSpeedDraft] = useState(speed);
  useEffect(() => { setSpeedDraft(speed); }, [speed]);
  // Cola de fotos recién subidas, todavía sin recortar — se recortan de a una;
  // "recropTarget" en cambio es el id de una foto YA en la galería que se está
  // volviendo a recortar (no una nueva).
  const [cropQueue, setCropQueue] = useState([]); // [{ raw, caption }]
  const [cropSource, setCropSource] = useState(null);
  const [recropTarget, setRecropTarget] = useState(null);
  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setError("");
    const queued = [];
    for (const file of files) {
      const isPng = file.type === "image/png";
      const b64 = await new Promise((resolve) => fileToBase64(file, resolve, 1600, isPng ? 1 : 0.9, isPng ? "image/png" : "image/jpeg"));
      queued.push({ raw: b64, caption: caption.trim() });
    }
    setCaption("");
    setCropQueue((q) => {
      const next = [...q, ...queued];
      if (!cropSource && !recropTarget && next.length) setCropSource(next[0].raw);
      return next;
    });
  };

  const recropItem = (it) => { setRecropTarget(it.id); setCropSource(it.image); };

  const saveAndAdvance = async (item) => {
    setUploading(true);
    const result = await onAdd(item);
    setUploading(false);
    if (!result.ok) {
      setError(result.error ? `No se pudo guardar la foto. Motivo: ${result.error}` : "No se pudo guardar la foto. Revisá tu conexión a internet e intentá de nuevo.");
    }
  };

  const handleCropConfirm = async (croppedBase64) => {
    if (recropTarget) {
      const target = items.find((i) => i.id === recropTarget);
      await saveAndAdvance({ ...target, image: croppedBase64 });
      setRecropTarget(null);
      setCropSource(null);
      return;
    }
    const current = cropQueue[0];
    await saveAndAdvance({ id: genId("cw"), caption: current?.caption || "", image: croppedBase64 });
    setCropQueue((q) => {
      const next = q.slice(1);
      setCropSource(next.length ? next[0].raw : null);
      return next;
    });
  };

  const handleCropCancel = () => {
    if (recropTarget) { setRecropTarget(null); setCropSource(null); return; }
    setCropQueue((q) => {
      const next = q.slice(1);
      setCropSource(next.length ? next[0].raw : null);
      return next;
    });
  };

  return (
    <div className="rounded-2xl p-5 flex flex-col gap-4" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
      <div>
        <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Trabajos personalizados (galería del inicio)</h4>
        <p className="text-xs mt-1" style={{ color: "var(--slate)" }}>
          Subí fotos de pedidos personalizados reales que ya entregaste. Después de elegir las fotos vas a poder acomodar cada una (arrastrar y hacer zoom) para que se vea exactamente la parte que querés, sin que se corte feo. Aparecen en el inicio, cerca de "Personalizar", en una tira que se desliza sola despacio y se detiene si pasás el mouse — activala y ubicala en "Secciones del inicio" más abajo.
        </p>
      </div>
      <div className="rounded-xl p-3" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold" style={{ color: "var(--bone)" }}>Velocidad del deslizamiento automático</label>
          <span className="text-xs" style={{ color: "var(--slate)" }}>{speedDraft <= 0.4 ? "Lento" : speedDraft >= 1.2 ? "Rápido" : "Media"}</span>
        </div>
        <input
          type="range"
          min={CUSTOMWORK_SPEED_MIN}
          max={CUSTOMWORK_SPEED_MAX}
          step="0.1"
          value={speedDraft}
          onChange={(e) => setSpeedDraft(Number(e.target.value))}
          onMouseUp={() => onSpeedChange?.(speedDraft)}
          onTouchEnd={() => onSpeedChange?.(speedDraft)}
          className="w-full"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input placeholder="Leyenda de la foto (opcional)" value={caption} onChange={(e) => setCaption(e.target.value)} className="rounded-xl p-2 text-sm flex-1 min-w-[160px]" style={inputStyle} />
        <label className="kulto-btn text-sm font-semibold px-4 py-2.5 rounded-full cursor-pointer flex items-center gap-2 shrink-0" style={{ background: uploading ? "var(--ink-3)" : "var(--signal)", color: "var(--bone)" }}>
          {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />} {uploading ? "Subiendo…" : "Subir fotos"}
          <input type="file" accept="image/png,image/jpeg" multiple className="hidden" disabled={uploading} onChange={(e) => { handleFiles(e.target.files); e.target.value = ""; }} />
        </label>
      </div>
      {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
      {items.length === 0 ? (
        <EmptyState text="Todavía no subiste fotos de trabajos personalizados." />
      ) : (
        <div className="flex flex-wrap gap-3">
          {items.map((it) => (
            <div key={it.id} className="flex flex-col items-center gap-1">
              <div className="relative w-16 rounded-lg overflow-hidden flex items-center justify-center" style={{ aspectRatio: "4 / 5", background: "var(--ink-3)", border: "1px solid var(--line)" }}>
                <img loading="lazy" src={it.image} className="w-full h-full object-cover" alt={it.caption || "Trabajo personalizado"} />
                <button
                  onClick={() => recropItem(it)}
                  className="kulto-btn absolute top-0.5 left-0.5 w-5 h-5 rounded-full flex items-center justify-center"
                  style={{ background: "rgba(21,19,26,0.8)", color: "var(--bone)" }}
                  title="Recortar de nuevo"
                >
                  <Pencil size={10} />
                </button>
              </div>
              {it.caption && <span className="text-[10px] text-center max-w-[80px] truncate" style={{ color: "var(--slate)" }}>{it.caption}</span>}
              <button onClick={() => onRemove(it.id)} className="kulto-btn" style={{ color: "var(--signal)" }} title="Quitar de la galería"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
      {cropSource && (
        <CropModal
          source={cropSource}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
          fitMode="contain"
          title="Se ve tu foto completa. Si querés recortarla más de cerca, usá el zoom."
        />
      )}
    </div>
  );
}

function AdminPanel({ products, categories, groups, orders, customers, onAdjustCustomerPoints, onDeleteCustomer, onCreateCustomer, onUpdateCustomerInfo, onSendPasswordHelp, reviews, settings, hasDraftChanges, publishing, onPublishChanges, onDiscardChanges, photoInbox, onAddToInbox, onCreateProductFromInbox, onAddInboxToExisting, onRemoveFromInbox, savedColors, onSaveColorToLibrary, onRemoveColorFromLibrary, designLibrary, onAddDesignToLibrary, onRemoveDesignFromLibrary, designFolders, onAddDesignFolder, onRenameDesignFolder, onRemoveDesignFolder, onToggleDesignFolderCover, onAssignDesignToFolder, onSetDesignFolderCategory, customWorkGallery, onAddCustomWork, onRemoveCustomWork, onAddCategory, onRenameCategory, onDeleteCategory, onAddGroup, onRenameGroup, onDeleteGroup, onSaveProduct, onQuickRestock, onDeleteProduct, onToggleOrderStatus, onUpdateTracking, onApplyDiscount, onRequestReview, onBulkComplete, onBulkArchive, onBulkDelete, onSaveReview, onDeleteReview, onReorderReview, onSaveSettings, onLogout, permissions, isOwner, onSetAdminPermissions, jumpTo }) {
  // El dueño (isOwner) siempre ve todas las pestañas. Una cuenta de admin con
  // permisos limitados solo ve — y solo puede abrir — las que le dieron.
  const allowedTabs = isOwner ? ADMIN_TAB_KEYS : (permissions || []);
  const [tab, setTab] = useState(() => (allowedTabs.includes("productos") ? "productos" : (allowedTabs[0] || "productos")));
  // El menú de accesos rápidos (ver Header) puede pedir saltar directo a una
  // pestaña puntual desde cualquier parte de la web — jumpTo trae un objeto
  // nuevo cada vez que se elige un destino (aunque sea el mismo de antes),
  // para que este efecto siempre dispare.
  useEffect(() => {
    if (jumpTo?.tab && allowedTabs.includes(jumpTo.tab)) setTab(jumpTo.tab);
  }, [jumpTo]);
  // Productos normales y prendas base para Personalizar se editan por separado,
  // cada una en su propia pestaña, para no mezclarlas nunca en la misma lista.
  const [editingProduct, setEditingProduct] = useState(null);
  const [editingTemplate, setEditingTemplate] = useState(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const templateProducts = products.filter((p) => p.tags?.template);
  const sellableProducts = products.filter((p) => !p.tags?.template);
  // La lista de productos se agrupa por categoría, como carpetas cerradas —
  // togglear una la abre/cierra, para no tener que scrollear una lista larga
  // cuando hay muchos productos.
  const [expandedProductCats, setExpandedProductCats] = useState([]);
  const toggleProductCat = (cat) => setExpandedProductCats((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  // Para borrar varios productos de una en vez de uno por uno.
  const [selectedProductIds, setSelectedProductIds] = useState([]);
  const [deletingSelected, setDeletingSelected] = useState(false);
  const toggleProductSelect = (id) => setSelectedProductIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  const deleteSelectedProducts = async () => {
    if (!selectedProductIds.length) return;
    if (!window.confirm(`¿Borrar ${selectedProductIds.length} producto${selectedProductIds.length === 1 ? "" : "s"}? Esta acción no se puede deshacer.`)) return;
    setDeletingSelected(true);
    for (const id of selectedProductIds) await onDeleteProduct(id);
    setDeletingSelected(false);
    setSelectedProductIds([]);
  };
  // Para mandar de una varios productos sueltos ("Sin grupo / temática" o
  // un grupo equivocado) al grupo correcto, sin editarlos uno por uno.
  const [bulkGroupTarget, setBulkGroupTarget] = useState("");
  const [movingSelected, setMovingSelected] = useState(false);
  const moveSelectedToGroup = async () => {
    if (!selectedProductIds.length || !bulkGroupTarget) return;
    setMovingSelected(true);
    for (const id of selectedProductIds) {
      const p = sellableProducts.find((x) => x.id === id);
      if (p) await onSaveProduct({ ...p, group: bulkGroupTarget });
    }
    setMovingSelected(false);
    setSelectedProductIds([]);
    setBulkGroupTarget("");
  };
  // Para decir en qué otras prendas (modelos) está también disponible cada
  // diseño de un grupo — ej: el diseño "kulto_01" en Oversize y Beagle, pero
  // "kulto_07" solo en Oversize — sin entrar a editar cada uno. Usa el mismo
  // mecanismo de "designGroup" que ya vincula un mismo diseño entre estilos
  // (ver "Vincular con otro estilo" / "Duplicar en otras categorías" del
  // formulario de producto): tildar un modelo nuevo crea una copia vinculada
  // en esa categoría, destildar uno borra esa copia.
  const [expandedModelsFor, setExpandedModelsFor] = useState(null);
  const [savingModelsFor, setSavingModelsFor] = useState(null);
  const linkedVariants = (p) => (p.designGroup ? sellableProducts.filter((x) => x.designGroup === p.designGroup) : [p]);
  const toggleModelForProduct = async (p, cat) => {
    if (cat === p.category || savingModelsFor) return;
    const variants = linkedVariants(p);
    const existing = variants.find((x) => x.category === cat);
    setSavingModelsFor(p.id);
    try {
      if (existing) {
        if (window.confirm(`¿Quitar "${p.name}" de "${cat}"? Esto borra esa copia (no afecta a las demás prendas donde está).`)) {
          await onDeleteProduct(existing.id);
        }
      } else {
        let group = p.designGroup;
        let base = p;
        if (!group) {
          group = `${p.name} (${genId("dg").slice(-5)})`;
          base = { ...p, designGroup: group };
          await onSaveProduct(base);
        }
        // Que un diseño esté disponible en otra prenda no significa que
        // también sea "más vendido", "oferta" o "tendencia" — cada modelo
        // arranca sin esas etiquetas, aunque el original ya las tuviera.
        const copy = { ...base, id: genId("p"), category: cat, designGroup: group, sku: generateSku(base.name, sellableProducts), tags: { ...base.tags, bestseller: false, oferta: false, tendencia: false }, createdAt: Date.now(), salesCount: 0, viewsCount: 0 };
        await onSaveProduct(copy);
      }
    } finally {
      setSavingModelsFor(null);
    }
  };
  // Igual que "Modelos donde está disponible" de arriba, pero para varios
  // productos seleccionados de una sola vez. Cada diseño se copia a su
  // propia categoría — nunca quedan todos amontonados en una sola carpeta
  // de prenda, cada copia va a la que corresponde.
  const [bulkModelsOpen, setBulkModelsOpen] = useState(false);
  const [bulkModelCats, setBulkModelCats] = useState([]);
  const [applyingBulkModels, setApplyingBulkModels] = useState(false);
  const toggleBulkModelCat = (cat) => setBulkModelCats((prev) => (prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]));
  const applyBulkModels = async () => {
    if (!selectedProductIds.length || !bulkModelCats.length) return;
    setApplyingBulkModels(true);
    let knownProducts = sellableProducts;
    for (const id of selectedProductIds) {
      const p = knownProducts.find((x) => x.id === id);
      if (!p) continue;
      const existingCats = new Set(knownProducts.filter((x) => x.id === p.id || (p.designGroup && x.designGroup === p.designGroup)).map((x) => x.category));
      let group = p.designGroup;
      let base = p;
      for (const cat of bulkModelCats) {
        if (existingCats.has(cat)) continue;
        if (!group) {
          group = `${p.name} (${genId("dg").slice(-5)})`;
          base = { ...p, designGroup: group };
          await onSaveProduct(base);
          knownProducts = knownProducts.map((x) => (x.id === base.id ? base : x));
        }
        // Que un diseño esté disponible en otra prenda no significa que
        // también sea "más vendido", "oferta" o "tendencia" — cada modelo
        // arranca sin esas etiquetas, aunque el original ya las tuviera.
        const copy = { ...base, id: genId("p"), category: cat, designGroup: group, sku: generateSku(base.name, knownProducts), tags: { ...base.tags, bestseller: false, oferta: false, tendencia: false }, createdAt: Date.now(), salesCount: 0, viewsCount: 0 };
        await onSaveProduct(copy);
        knownProducts = [...knownProducts, copy];
        existingCats.add(cat);
      }
    }
    setApplyingBulkModels(false);
    setBulkModelsOpen(false);
    setBulkModelCats([]);
    setSelectedProductIds([]);
  };
  // Para cambiar precio, stock y/o talles de varios productos seleccionados
  // de una sola vez (además de poder seguir editando cada uno individual
  // con el lápiz, como siempre). Cada campo se aplica solo si se completó —
  // dejar un campo vacío no toca ese dato en los productos seleccionados.
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkPrice, setBulkPrice] = useState("");
  const [bulkStock, setBulkStock] = useState("");
  const [bulkSizesOn, setBulkSizesOn] = useState(false);
  const [bulkSizes, setBulkSizes] = useState([]);
  const [applyingBulkEdit, setApplyingBulkEdit] = useState(false);
  const toggleBulkSize = (s) => setBulkSizes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const bulkEditReady = String(bulkPrice).trim() !== "" || String(bulkStock).trim() !== "" || bulkSizesOn;
  const applyBulkEdit = async () => {
    if (!selectedProductIds.length || !bulkEditReady) return;
    const hasPrice = String(bulkPrice).trim() !== "";
    const hasStock = String(bulkStock).trim() !== "";
    setApplyingBulkEdit(true);
    for (const id of selectedProductIds) {
      const p = sellableProducts.find((x) => x.id === id);
      if (!p) continue;
      const updates = { ...p };
      if (hasPrice) updates.price = Number(bulkPrice) || 0;
      if (hasStock) updates.stock = Number(bulkStock) || 0;
      if (bulkSizesOn) updates.sizes = bulkSizes;
      await onSaveProduct(updates);
    }
    setApplyingBulkEdit(false);
    setBulkEditOpen(false);
    setBulkPrice("");
    setBulkStock("");
    setBulkSizesOn(false);
    setBulkSizes([]);
    setSelectedProductIds([]);
  };

  const discard = async () => {
    await onDiscardChanges();
    setEditingProduct(null);
    setEditingTemplate(null);
    setConfirmingDiscard(false);
  };

  return (
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-10">
      <div className="flex items-center justify-between mb-6">
        <SectionTitle eyebrow="Solo para el equipo Kulto" title="Panel de administrador" />
        <button onClick={onLogout} className="kulto-btn text-sm flex items-center gap-1 px-3 py-2 rounded-full" style={{ color: "var(--slate)", border: "1px solid var(--line)" }}>
          <LogOut size={15} /> Salir
        </button>
      </div>

      <div className="flex gap-2 mb-6 overflow-x-auto kulto-scrollbar pb-1 -mx-4 px-4 md:mx-0 md:px-0">
        {ADMIN_TABS.filter(([key]) => allowedTabs.includes(key)).map(([key, label]) => (
          <button key={key} onClick={() => setTab(key)} className="kulto-btn text-sm font-semibold px-4 py-2 rounded-full shrink-0 whitespace-nowrap" style={{ background: tab === key ? "var(--signal)" : "var(--ink-2)", color: "var(--bone)", border: "1px solid var(--line)" }}>
            {label}
          </button>
        ))}
      </div>

      {tab === "productos" && (
        <>
          <div
            className="rounded-2xl p-4 mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3"
            style={{ background: hasDraftChanges ? "var(--ink-2)" : "transparent", border: hasDraftChanges ? "1px solid var(--sun)" : "1px dashed var(--line)" }}
          >
            <div>
              <p className="text-sm font-semibold" style={{ color: hasDraftChanges ? "var(--sun)" : "var(--slate)" }}>
                {hasDraftChanges ? "Tenés cambios sin publicar" : "No hay cambios pendientes"}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--slate)" }}>
                Acá podés subir fotos, armar productos y cambiar categorías con calma — nadie los ve hasta que toques "Subir cambios".
              </p>
            </div>
            <div className="flex gap-2 shrink-0">
              {confirmingDiscard ? (
                <>
                  <span className="text-xs self-center" style={{ color: "var(--slate)" }}>¿Descartar todo lo sin publicar?</span>
                  <button onClick={discard} className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full" style={{ background: "var(--signal)", color: "var(--bone)" }}>Sí, descartar</button>
                  <button onClick={() => setConfirmingDiscard(false)} className="kulto-btn text-xs px-3 py-2" style={{ color: "var(--slate)" }}>Cancelar</button>
                </>
              ) : (
                <>
                  {hasDraftChanges && (
                    <button onClick={() => setConfirmingDiscard(true)} className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full" style={{ background: "var(--ink-3)", color: "var(--bone)" }}>
                      Descartar cambios
                    </button>
                  )}
                  <button
                    disabled={!hasDraftChanges || publishing}
                    onClick={onPublishChanges}
                    className="kulto-btn text-sm font-semibold px-4 py-2 rounded-full flex items-center gap-2"
                    style={{
                      background: !hasDraftChanges ? "var(--ink-3)" : "var(--sun)",
                      color: !hasDraftChanges ? "var(--slate)" : "var(--ink)",
                      cursor: !hasDraftChanges ? "default" : "pointer",
                    }}
                  >
                    {publishing ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                    Subir cambios
                  </button>
                </>
              )}
            </div>
          </div>

          <AdminPhotoInbox
            inbox={photoInbox}
            draftProducts={products}
            categories={categories}
            groups={groups}
            onAddFiles={onAddToInbox}
            onCreateProduct={onCreateProductFromInbox}
            onAddToExisting={onAddInboxToExisting}
            onRemove={onRemoveFromInbox}
          />

          <AdminBulkProductUpload categories={categories} groups={groups} allProducts={sellableProducts} onSaveProduct={onSaveProduct} />

          <div className="grid md:grid-cols-2 gap-6 mt-6">
            <div className="flex flex-col gap-6">
              <AdminProductForm categories={categories} groups={groups} onAddCategory={onAddCategory} onAddGroup={onAddGroup} savedColors={savedColors} onSaveColorToLibrary={onSaveColorToLibrary} onRemoveColorFromLibrary={onRemoveColorFromLibrary} onSave={async (p) => { await onSaveProduct(p); setEditingProduct(null); }} editing={editingProduct} onCancelEdit={() => setEditingProduct(null)} allProducts={sellableProducts} />
              <AdminGroupManager groups={groups} onRename={onRenameGroup} onDelete={onDeleteGroup} />
              <AdminCategoryManager categories={categories} onRename={onRenameCategory} onDelete={onDeleteCategory} />
            </div>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Productos ({sellableProducts.length})</p>
                {selectedProductIds.length > 0 && (
                  <div className="flex items-center gap-2 flex-wrap">
                    {groups.length > 0 && (
                      <>
                        <select
                          value={bulkGroupTarget}
                          onChange={(e) => setBulkGroupTarget(e.target.value)}
                          className="rounded-full text-xs px-3 py-1.5"
                          style={{ background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" }}
                        >
                          <option value="">Mover a grupo…</option>
                          {groups.map((g) => <option key={g} value={g}>{g}</option>)}
                        </select>
                        <button
                          type="button"
                          disabled={!bulkGroupTarget || movingSelected}
                          onClick={moveSelectedToGroup}
                          className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1 shrink-0"
                          style={{ background: "var(--sun)", color: "var(--ink)", opacity: !bulkGroupTarget || movingSelected ? 0.5 : 1 }}
                        >
                          {movingSelected ? <Loader2 size={13} className="animate-spin" /> : <FolderPlus size={13} />}
                          Mover {selectedProductIds.length}
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setBulkModelsOpen((v) => !v)}
                      className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1 shrink-0"
                      style={{ background: bulkModelsOpen ? "var(--sun)" : "var(--ink-3)", color: bulkModelsOpen ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)" }}
                    >
                      <Boxes size={13} /> Modelos disponibles
                    </button>
                    <button
                      type="button"
                      onClick={() => setBulkEditOpen((v) => !v)}
                      className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1 shrink-0"
                      style={{ background: bulkEditOpen ? "var(--sun)" : "var(--ink-3)", color: bulkEditOpen ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)" }}
                    >
                      <Pencil size={13} /> Precio / stock / talles
                    </button>
                    <button
                      type="button"
                      disabled={deletingSelected}
                      onClick={deleteSelectedProducts}
                      className="kulto-btn text-xs font-semibold px-3 py-1.5 rounded-full flex items-center gap-1 shrink-0"
                      style={{ background: "var(--signal)", color: "var(--bone)", opacity: deletingSelected ? 0.6 : 1 }}
                    >
                      {deletingSelected ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      Borrar {selectedProductIds.length}
                    </button>
                  </div>
                )}
              </div>
              <p className="text-xs -mt-2" style={{ color: "var(--slate)" }}>
                Toca un producto para editarlo, o marcá el círculo para seleccionar varios: podés moverlos todos juntos a otro grupo/temática, decir en qué otras prendas están disponibles, o borrarlos de una. Esta lista incluye tus cambios sin publicar. Las prendas base para Personalizar no aparecen acá — tienen su propia pestaña.
              </p>
              {selectedProductIds.length > 0 && bulkModelsOpen && (
                <div className="rounded-xl p-3 flex flex-col gap-2 -mt-1" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
                  <p className="text-[11px]" style={{ color: "var(--slate)" }}>
                    Tildá en qué otras prendas tienen que estar disponibles los {selectedProductIds.length} diseños seleccionados. Cada uno se crea en su propia categoría — no quedan todos amontonados en una sola.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => toggleBulkModelCat(cat)}
                        className="kulto-btn text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
                        style={{ background: bulkModelCats.includes(cat) ? "var(--sun)" : "var(--ink)", color: bulkModelCats.includes(cat) ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)" }}
                      >
                        {bulkModelCats.includes(cat) && <Check size={11} />} {cat}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={!bulkModelCats.length || applyingBulkModels}
                    onClick={applyBulkModels}
                    className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full self-start flex items-center gap-1"
                    style={{ background: "var(--signal)", color: "var(--bone)", opacity: !bulkModelCats.length || applyingBulkModels ? 0.5 : 1 }}
                  >
                    {applyingBulkModels ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    {applyingBulkModels ? "Creando…" : `Aplicar a ${selectedProductIds.length} seleccionado${selectedProductIds.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              )}
              {selectedProductIds.length > 0 && bulkEditOpen && (
                <div className="rounded-xl p-3 flex flex-col gap-3 -mt-1" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }}>
                  <p className="text-[11px]" style={{ color: "var(--slate)" }}>
                    Cambiá precio, stock y/o talles para los {selectedProductIds.length} seleccionados de una sola vez. Dejá un campo vacío (o sin tildar) para no tocar ese dato — podés seguir editando cada producto individualmente con el lápiz cuando quieras.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      type="number"
                      placeholder="Nuevo precio (€) — opcional"
                      value={bulkPrice}
                      onChange={(e) => setBulkPrice(e.target.value)}
                      className="rounded-lg p-2 text-sm flex-1 min-w-[140px]"
                      style={{ background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                    <input
                      type="number"
                      placeholder="Nuevo stock — opcional"
                      value={bulkStock}
                      onChange={(e) => setBulkStock(e.target.value)}
                      className="rounded-lg p-2 text-sm flex-1 min-w-[140px]"
                      style={{ background: "var(--ink)", color: "var(--bone)", border: "1px solid var(--line)" }}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 text-[11px]" style={{ color: "var(--slate)" }}>
                      <input type="checkbox" checked={bulkSizesOn} onChange={(e) => setBulkSizesOn(e.target.checked)} style={{ accentColor: "var(--signal)" }} />
                      Cambiar talles (reemplaza los talles actuales de cada seleccionado por estos)
                    </label>
                    {bulkSizesOn && (
                      <div className="flex flex-wrap gap-1.5">
                        {SIZE_PRESETS.map((s) => (
                          <button
                            key={s}
                            type="button"
                            onClick={() => toggleBulkSize(s)}
                            className="kulto-btn text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
                            style={{ background: bulkSizes.includes(s) ? "var(--sun)" : "var(--ink)", color: bulkSizes.includes(s) ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)" }}
                          >
                            {bulkSizes.includes(s) && <Check size={11} />} {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!bulkEditReady || applyingBulkEdit}
                    onClick={applyBulkEdit}
                    className="kulto-btn text-xs font-semibold px-3 py-2 rounded-full self-start flex items-center gap-1"
                    style={{ background: "var(--signal)", color: "var(--bone)", opacity: !bulkEditReady || applyingBulkEdit ? 0.5 : 1 }}
                  >
                    {applyingBulkEdit ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                    {applyingBulkEdit ? "Guardando…" : `Aplicar a ${selectedProductIds.length} seleccionado${selectedProductIds.length === 1 ? "" : "s"}`}
                  </button>
                </div>
              )}
              {sellableProducts.length === 0 && <EmptyState text="Todavía no cargaste ningún producto." />}
              {Object.entries(
                sellableProducts.reduce((acc, p) => {
                  // Se agrupa por grupo/temática (ej: "kulto", "anime") y no
                  // por categoría — la categoría es solo la prenda física, lo
                  // que de verdad organiza los diseños para el dueño es el
                  // grupo/temática al que pertenecen.
                  const grp = p.group || "Sin grupo / temática";
                  (acc[grp] = acc[grp] || []).push(p);
                  return acc;
                }, {})
              ).map(([grp, items]) => {
                const isOpen = expandedProductCats.includes(grp) || items.some((p) => editingProduct?.id === p.id);
                const allSelected = items.length > 0 && items.every((p) => selectedProductIds.includes(p.id));
                const toggleSelectGroup = (e) => {
                  e.stopPropagation();
                  const ids = items.map((p) => p.id);
                  setSelectedProductIds((prev) => (allSelected ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))));
                };
                return (
                  <div key={grp} className="rounded-2xl overflow-hidden" style={{ border: "1px solid var(--line)" }}>
                    <div className="w-full flex items-center gap-2 p-3" style={{ background: "var(--ink-2)" }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleSelectGroup}
                        onClick={(e) => e.stopPropagation()}
                        className="shrink-0"
                        style={{ accentColor: "var(--signal)" }}
                        aria-label={`Seleccionar todo "${grp}"`}
                      />
                      <button
                        type="button"
                        onClick={() => toggleProductCat(grp)}
                        className="kulto-btn flex-1 flex items-center gap-2 text-left"
                      >
                        {isOpen ? <ChevronDown size={16} color="var(--slate)" /> : <ChevronRight size={16} color="var(--slate)" />}
                        <span className="text-sm font-semibold flex-1" style={{ color: "var(--bone)" }}>{grp}</span>
                        <span className="text-xs" style={{ color: "var(--slate)" }}>{items.length} producto{items.length === 1 ? "" : "s"}</span>
                      </button>
                    </div>
                    {isOpen && (
                      <div className="flex flex-col gap-3 p-2 pt-0" style={{ background: "var(--ink-2)" }}>
                        {Object.entries(
                          items.reduce((acc, p) => {
                            // Dentro de cada grupo/temática, a su vez se separa
                            // por categoría (la prenda física) — para que, por
                            // ejemplo, "Sudaderas" quede en su propia carpeta y
                            // no mezclado con "Camisetas" del mismo diseño.
                            const cat = p.category || "Sin categoría";
                            (acc[cat] = acc[cat] || []).push(p);
                            return acc;
                          }, {})
                        ).map(([cat, catItems]) => {
                          const catAllSelected = catItems.length > 0 && catItems.every((p) => selectedProductIds.includes(p.id));
                          const toggleSelectCat = () => {
                            const ids = catItems.map((p) => p.id);
                            setSelectedProductIds((prev) => (catAllSelected ? prev.filter((id) => !ids.includes(id)) : Array.from(new Set([...prev, ...ids]))));
                          };
                          return (
                          <div key={cat} className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--line)" }}>
                            <label className="flex items-center gap-2 px-3 py-1.5 cursor-pointer" style={{ background: "var(--ink-3)" }}>
                              <input
                                type="checkbox"
                                checked={catAllSelected}
                                onChange={toggleSelectCat}
                                style={{ accentColor: "var(--signal)" }}
                                aria-label={`Seleccionar todo "${cat}"`}
                              />
                              <p className="text-[11px] font-semibold" style={{ color: "var(--slate)" }}>
                                {cat} · {catItems.length}
                              </p>
                            </label>
                            <div className="flex flex-col gap-2 p-2">
                        {catItems.map((p) => {
                          const modelsOpen = expandedModelsFor === p.id;
                          const variants = linkedVariants(p);
                          return (
                          <div key={p.id} className="flex flex-col gap-1.5">
                            <div
                              onClick={() => setEditingProduct(p)}
                              className="kulto-btn flex items-center gap-3 rounded-2xl p-3 text-left"
                              style={{ background: editingProduct?.id === p.id ? "var(--ink-3)" : "var(--ink)", border: editingProduct?.id === p.id ? "1px solid var(--sun)" : "1px solid var(--line)", opacity: p.hidden ? 0.5 : 1 }}
                            >
                              <input
                                type="checkbox"
                                checked={selectedProductIds.includes(p.id)}
                                onChange={() => toggleProductSelect(p.id)}
                                onClick={(e) => e.stopPropagation()}
                                className="shrink-0"
                                style={{ accentColor: "var(--signal)" }}
                                aria-label={`Seleccionar ${p.name}`}
                              />
                              <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: p.colors?.[0]?.hex || "var(--ink-3)" }}>
                                {(p.photoPool?.[0] || getColorImages(p.colors?.[0])[0]) ? <img loading="lazy" src={p.photoPool?.[0] || getColorImages(p.colors?.[0])[0]} className="w-full h-full object-contain p-0.5" alt={p.name} /> : <Shirt size={18} color="rgba(243,239,230,0.4)" />}
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold truncate" style={{ color: "var(--bone)" }}>{p.name}</p>
                                <p className="text-xs" style={{ color: "var(--slate)" }}>{p.category ? `${p.category} · ` : ""}{formatPrice(p.price)} · stock {p.stock}{p.hidden ? " · Oculto para clientes" : ""}{variants.length > 1 ? ` · ${variants.length} modelos` : ""}</p>
                              </div>
                              <button
                                onClick={(e) => { e.stopPropagation(); onSaveProduct({ ...p, hidden: !p.hidden }); }}
                                className="kulto-btn text-[11px] px-2 py-1.5 rounded-full font-semibold flex items-center gap-1 shrink-0"
                                style={{ background: p.hidden ? "var(--ink)" : "var(--sun)", color: p.hidden ? "var(--bone)" : "var(--ink)" }}
                                aria-label={p.hidden ? "Mostrar producto" : "Ocultar producto"}
                              >
                                {p.hidden ? <><Eye size={13} /> Mostrar</> : <><EyeOff size={13} /> Ocultar</>}
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setExpandedModelsFor(modelsOpen ? null : p.id); }}
                                className="kulto-btn p-2 rounded-full"
                                style={{ color: modelsOpen ? "var(--sun)" : "var(--bone)" }}
                                aria-label="Modelos donde está disponible"
                                title="Modelos donde está disponible"
                              >
                                <Boxes size={16} />
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); setEditingProduct(p); }} className="kulto-btn p-2 rounded-full" style={{ color: "var(--bone)" }} aria-label="Editar producto"><Pencil size={16} /></button>
                              <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`¿Borrar "${p.name}"? Esta acción no se puede deshacer.`)) onDeleteProduct(p.id); }} className="kulto-btn p-2 rounded-full" style={{ color: "var(--signal)" }} aria-label="Borrar producto"><Trash2 size={16} /></button>
                            </div>
                            {modelsOpen && (
                              <div className="rounded-xl p-3 flex flex-col gap-2 ml-2" style={{ background: "var(--ink-3)", border: "1px solid var(--line)" }} onClick={(e) => e.stopPropagation()}>
                                <p className="text-[11px]" style={{ color: "var(--slate)" }}>
                                  Tildá los modelos donde también está disponible "{p.name}". Destildá uno para sacarlo de ese modelo.
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                  {categories.map((cat) => {
                                    const isOwn = cat === p.category;
                                    const isOn = isOwn || variants.some((v) => v.category === cat);
                                    return (
                                      <button
                                        key={cat}
                                        type="button"
                                        disabled={isOwn || savingModelsFor === p.id}
                                        onClick={() => toggleModelForProduct(p, cat)}
                                        className="kulto-btn text-[11px] font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"
                                        style={{ background: isOn ? "var(--sun)" : "var(--ink)", color: isOn ? "var(--ink)" : "var(--bone)", border: "1px solid var(--line)", opacity: isOwn ? 0.7 : 1 }}
                                      >
                                        {isOn && <Check size={11} />} {cat}
                                      </button>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                          );
                        })}
                            </div>
                          </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === "personalizar" && (
        <div className="flex flex-col gap-6">
          <div className="grid md:grid-cols-2 gap-6">
            <div className="flex flex-col gap-6">
              <div className="rounded-2xl p-3 text-xs" style={{ background: "var(--ink-2)", border: "1px dashed var(--line)", color: "var(--slate)" }}>
                Acá cargás y editás únicamente las prendas base que se usan en "Personalizar" — no se mezclan con el catálogo de venta normal.
              </div>
              <AdminTemplateForm
                categories={categories}
                templateProducts={templateProducts}
                onAddCategory={onAddCategory}
                onSave={async (p) => { await onSaveProduct(p); setEditingTemplate(null); }}
                editing={editingTemplate}
                onCancelEdit={() => setEditingTemplate(null)}
              />
            </div>
            <div className="flex flex-col gap-3">
              <p className="text-sm font-semibold" style={{ color: "var(--bone)" }}>Prendas base para sublimar ({templateProducts.length})</p>
              <p className="text-xs -mt-2" style={{ color: "var(--slate)" }}>
                Estas son, y solo estas, las prendas que aparecen en el paso 1 de "Personalizar" en la web. Toca una para editarla.
              </p>
              {templateProducts.length === 0 && <EmptyState text="Todavía no cargaste ninguna prenda base para sublimar." />}
              {templateProducts.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setEditingTemplate(p)}
                  className="kulto-btn flex items-center gap-3 rounded-2xl p-3 text-left"
                  style={{ background: editingTemplate?.id === p.id ? "var(--ink-3)" : "var(--ink-2)", border: editingTemplate?.id === p.id ? "1px solid var(--sun)" : "1px solid var(--line)", opacity: p.hidden ? 0.5 : 1 }}
                >
                  <div className="w-12 h-12 rounded-xl overflow-hidden shrink-0 flex items-center justify-center" style={{ background: p.colors?.[0]?.hex || "var(--ink-3)" }}>
                    {(p.colors?.[0]?.frontImage || p.photoPool?.[0]) ? <img loading="lazy" src={p.colors?.[0]?.frontImage || p.photoPool?.[0]} className="w-full h-full object-contain p-0.5" alt={p.name} /> : <Shirt size={18} color="rgba(243,239,230,0.4)" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: "var(--bone)" }}>{p.name}</p>
                    <p className="text-xs" style={{ color: "var(--slate)" }}>
                      {p.category}{p.subcategory ? ` · ${p.subcategory}` : ""} · {p.colors?.length || 0} color{(p.colors?.length || 0) === 1 ? "" : "es"}{p.price != null ? ` · ${formatPrice(p.price)}` : ""}{p.hidden ? " · Oculta para clientes" : ""}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); onSaveProduct({ ...p, hidden: !p.hidden }); }}
                    className="kulto-btn text-[11px] px-2 py-1.5 rounded-full font-semibold flex items-center gap-1 shrink-0"
                    style={{ background: p.hidden ? "var(--ink)" : "var(--sun)", color: p.hidden ? "var(--bone)" : "var(--ink)" }}
                    aria-label={p.hidden ? "Mostrar prenda" : "Ocultar prenda"}
                  >
                    {p.hidden ? <><Eye size={13} /> Mostrar</> : <><EyeOff size={13} /> Ocultar</>}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setEditingTemplate(p); }} className="kulto-btn p-2 rounded-full" style={{ color: "var(--bone)" }} aria-label="Editar prenda"><Pencil size={16} /></button>
                  <button onClick={(e) => { e.stopPropagation(); if (window.confirm(`¿Borrar "${p.name}"? Esta acción no se puede deshacer.`)) onDeleteProduct(p.id); }} className="kulto-btn p-2 rounded-full" style={{ color: "var(--signal)" }} aria-label="Borrar prenda"><Trash2 size={16} /></button>
                </div>
              ))}
            </div>
          </div>
          <AdminPersonalizeGroupImages templateProducts={templateProducts} settings={settings} onSave={onSaveSettings} />
          <AdminPersonalizeSubcategoryPrices templateProducts={templateProducts} settings={settings} onSave={onSaveSettings} />
          <AdminDesignLibrary
            designs={designLibrary}
            onAdd={onAddDesignToLibrary}
            onRemove={onRemoveDesignFromLibrary}
            folders={designFolders}
            categories={categories}
            onAddFolder={onAddDesignFolder}
            onRenameFolder={onRenameDesignFolder}
            onRemoveFolder={onRemoveDesignFolder}
            onToggleCover={onToggleDesignFolderCover}
            onAssignFolder={onAssignDesignToFolder}
            onSetFolderCategory={onSetDesignFolderCategory}
          />
          <AdminCustomWorkGallery items={customWorkGallery} onAdd={onAddCustomWork} onRemove={onRemoveCustomWork} speed={settings.customWorkSpeed} onSpeedChange={(v) => onSaveSettings({ customWorkSpeed: v })} />
        </div>
      )}

      {tab === "pedidos" && <AdminOrders orders={orders} onToggleStatus={onToggleOrderStatus} onUpdateTracking={onUpdateTracking} onApplyDiscount={onApplyDiscount} onRequestReview={onRequestReview} onBulkComplete={onBulkComplete} onBulkArchive={onBulkArchive} onBulkDelete={onBulkDelete} />}
      {tab === "ventas" && <AdminSalesPanel products={sellableProducts} orders={orders} settings={settings} onSaveSettings={onSaveSettings} />}
      {tab === "compras" && <AdminRestockPanel products={sellableProducts} onQuickRestock={onQuickRestock} settings={settings} onSaveSettings={onSaveSettings} />}
      {tab === "clientes" && <AdminCustomers customers={customers} onAdjustPoints={onAdjustCustomerPoints} loyaltyThreshold={settings?.loyaltyRewardThreshold} isOwner={isOwner} onSetAdminPermissions={onSetAdminPermissions} onDeleteCustomer={onDeleteCustomer} onCreateCustomer={onCreateCustomer} onUpdateCustomerInfo={onUpdateCustomerInfo} onSendPasswordHelp={onSendPasswordHelp} />}
      {tab === "resenas" && <AdminReviews reviews={reviews} onSave={onSaveReview} onDelete={onDeleteReview} onReorder={onReorderReview} />}
      {tab === "ajustes" && (
        <div className="flex flex-col gap-6">
          <AdminBrandSettings settings={settings} onSave={onSaveSettings} />
          <AdminBannerSettings settings={settings} groups={groups} onSave={onSaveSettings} />
          <AdminProductsMenu items={settings.productsMenuItems || []} categories={categories} groups={groups} onSave={onSaveSettings} />
          <AdminHowItWorksSettings settings={settings} onSave={onSaveSettings} />
          <AdminSectionSettings settings={settings} onSave={onSaveSettings} />
          <AdminThemeSettings settings={settings} onSave={onSaveSettings} />
          <AdminShippingSettings settings={settings} onSave={onSaveSettings} />
          <AdminDesignFeedbackSettings settings={settings} onSave={onSaveSettings} />
          <AdminPrintSizeGuideSettings settings={settings} onSave={onSaveSettings} />
          <AdminDepositSettings settings={settings} onSave={onSaveSettings} />
          <AdminEmailTestSettings settings={settings} />
          <AdminStoreTrustSettings settings={settings} onSave={onSaveSettings} />
          <AdminFaqSettings settings={settings} onSave={onSaveSettings} />
          <AdminLoyaltySettings settings={settings} onSave={onSaveSettings} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Header & footer                                                    */
/* ------------------------------------------------------------------ */

function NavLink({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className="kulto-btn text-sm font-semibold pb-1"
      style={{ color: "var(--bone)", borderBottom: active ? "2px solid var(--signal)" : "2px solid transparent" }}
    >
      {label}
    </button>
  );
}

function Header({ page, setPage, cartCount, onOpenCart, logoImage, logoText, customer, themeMode, onToggleThemeMode, fontStep, onDecreaseFont, onIncreaseFont, socialLinks = {}, showAdminMenu = false, onGoAdminTab, onPreviewAsCustomer, productsMenuItems = [], onGoCatalog }) {
  const [open, setOpen] = useState(false);
  const [adminMenuOpen, setAdminMenuOpen] = useState(false);
  const adminMenuRef = useRef(null);
  // Menú flotante de "Productos" (desktop) — lista "Catálogo" + los accesos
  // directos que el admin haya elegido a mano en Ajustes (no se arma solo
  // listando grupos, esos son otra cosa, se usan para los banners). El
  // desplegable del celular usa su propio estado porque se despliega inline
  // en vez de flotar.
  const [catalogMenuOpen, setCatalogMenuOpen] = useState(false);
  const [catalogMenuOpenMobile, setCatalogMenuOpenMobile] = useState(false);
  const catalogMenuRef = useRef(null);
  const goCatalog = (item) => {
    onGoCatalog?.(item ? { group: item.type === "group" ? item.value : "", category: item.type === "category" ? item.value : "" } : {});
    setOpen(false);
    setCatalogMenuOpen(false);
    setCatalogMenuOpenMobile(false);
  };
  const go = (p) => { setPage(p); setOpen(false); };
  useEffect(() => {
    if (!catalogMenuOpen) return;
    const onDocClick = (e) => {
      if (catalogMenuRef.current && !catalogMenuRef.current.contains(e.target)) setCatalogMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [catalogMenuOpen]);
  useEffect(() => {
    if (!adminMenuOpen) return;
    const onDocClick = (e) => {
      if (adminMenuRef.current && !adminMenuRef.current.contains(e.target)) setAdminMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [adminMenuOpen]);
  const ADMIN_QUICK_LINKS = [
    { label: "Clientes", onClick: () => onGoAdminTab?.("clientes") },
    { label: "Ver la web como cliente", onClick: () => onPreviewAsCustomer?.() },
    { label: "Panel de ventas", onClick: () => onGoAdminTab?.("ventas") },
    { label: "Logística / Pedidos", onClick: () => onGoAdminTab?.("pedidos") },
    { label: "Productos a comprar", onClick: () => onGoAdminTab?.("compras") },
    { label: "Diseños PNG", onClick: () => onGoAdminTab?.("personalizar") },
    { label: "Subir productos", onClick: () => onGoAdminTab?.("productos") },
  ];
  return (
    <header className="sticky top-0 z-40" style={{ background: "var(--ink)", borderBottom: "1px solid var(--line)" }}>
      <div className="max-w-6xl mx-auto px-4 md:px-6 flex items-center justify-between h-16">
        <button onClick={() => go("home")} className="flex items-center gap-2.5">
          {logoImage ? (
            <>
              <img src={logoImage} alt={logoText || "Logo"} className="h-9 w-9 object-contain" />
              {logoText && <span className="kulto-display text-lg tracking-wide" style={{ color: "var(--bone)" }}>{logoText}</span>}
            </>
          ) : (
            <span className="kulto-display text-xl tracking-wide" style={{ color: "var(--bone)" }}>{logoText || "KULTO"}</span>
          )}
        </button>
        <nav className="hidden md:flex items-center gap-8">
          <NavLink label="Inicio" active={page === "home"} onClick={() => go("home")} />
          <div className="relative" ref={catalogMenuRef}>
            <button
              onClick={() => setCatalogMenuOpen((o) => !o)}
              className="kulto-btn text-sm font-semibold pb-1 flex items-center gap-1"
              style={{ color: "var(--bone)", borderBottom: page === "catalog" ? "2px solid var(--signal)" : "2px solid transparent" }}
            >
              Productos <ChevronDown size={14} />
            </button>
            {catalogMenuOpen && (
              <div className="absolute left-0 top-full mt-2 rounded-xl overflow-hidden z-50" style={{ background: "var(--ink-2)", border: "1px solid var(--line)", minWidth: 180 }}>
                <button onClick={() => goCatalog(null)} className="kulto-btn w-full text-left px-4 py-2.5 text-sm" style={{ color: "var(--bone)" }}>
                  Catálogo
                </button>
                {productsMenuItems.map((it) => (
                  <React.Fragment key={it.id}>
                    <div style={{ height: 1, background: "var(--line)" }} />
                    <button onClick={() => goCatalog(it)} className="kulto-btn w-full text-left px-4 py-2.5 text-sm" style={{ color: "var(--bone)" }}>
                      {it.label || it.value}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
          <NavLink label="Personalizar" active={page === "wizard"} onClick={() => go("wizard")} />
          <NavLink label="Mi pedido" active={page === "seguimiento"} onClick={() => go("seguimiento")} />
          {customer && <NavLink label="Favoritos" active={page === "favoritos"} onClick={() => go("favoritos")} />}
          <NavLink label={customer ? "Mi cuenta" : "Ingresar"} active={page === "cuenta"} onClick={() => go("cuenta")} />
        </nav>
        <div className="flex items-center gap-1">
          <button
            onClick={onToggleThemeMode}
            className="kulto-btn w-8 h-8 rounded-full flex items-center justify-center shrink-0"
            style={{ border: "1px solid var(--line)", color: "var(--bone)" }}
            aria-label={themeMode === "light" ? "Activar modo oscuro" : "Activar modo claro"}
            title={themeMode === "light" ? "Modo oscuro" : "Modo claro"}
          >
            {themeMode === "light" ? <Moon size={15} /> : <Sun size={15} />}
          </button>
          <div className="hidden sm:flex items-center gap-1 rounded-full px-1.5 py-1 shrink-0" style={{ border: "1px solid var(--line)" }}>
            <button
              onClick={onDecreaseFont}
              disabled={fontStep <= 0}
              className="kulto-btn w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold"
              style={{ color: fontStep <= 0 ? "var(--slate)" : "var(--bone)" }}
              aria-label="Achicar el tamaño de letra"
              title="Achicar letra"
            >
              A-
            </button>
            <span className="text-xs px-1 select-none" style={{ color: "var(--slate)" }} aria-hidden="true">Aa</span>
            <button
              onClick={onIncreaseFont}
              disabled={fontStep >= 3}
              className="kulto-btn w-6 h-6 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ color: fontStep >= 3 ? "var(--slate)" : "var(--bone)" }}
              aria-label="Agrandar el tamaño de letra"
              title="Agrandar letra"
            >
              A+
            </button>
          </div>
          <div className="hidden sm:flex items-center gap-1">
            <a
              href={socialLinks.instagram || INSTAGRAM_URL}
              target="_blank"
              rel="noreferrer"
              className="kulto-btn p-2 rounded-full"
              style={{ color: "var(--bone)" }}
              title="Seguinos en Instagram"
            >
              <Instagram size={20} />
            </a>
            {socialLinks.facebook && (
              <a href={socialLinks.facebook} target="_blank" rel="noreferrer" className="kulto-btn p-2 rounded-full" style={{ color: "var(--bone)" }} title="Seguinos en Facebook">
                <Facebook size={20} />
              </a>
            )}
            {socialLinks.tiktok && (
              <a href={socialLinks.tiktok} target="_blank" rel="noreferrer" className="kulto-btn p-2 rounded-full" style={{ color: "var(--bone)" }} title="Seguinos en TikTok">
                <Music2 size={20} />
              </a>
            )}
          </div>
          {showAdminMenu && (
            <div className="relative" ref={adminMenuRef}>
              <button
                onClick={() => setAdminMenuOpen((o) => !o)}
                className="kulto-btn p-2 rounded-full"
                style={{ color: "var(--bone)" }}
                aria-label="Accesos rápidos de administrador"
                title="Accesos rápidos"
              >
                <LayoutGrid size={20} />
              </button>
              {adminMenuOpen && (
                <div
                  className="absolute right-0 mt-2 w-64 rounded-2xl overflow-hidden shadow-xl z-50"
                  style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}
                >
                  {ADMIN_QUICK_LINKS.map((item) => (
                    <button
                      key={item.label}
                      onClick={() => { item.onClick(); setAdminMenuOpen(false); }}
                      className="kulto-btn w-full text-left px-4 py-3 text-sm"
                      style={{ color: "var(--bone)", borderBottom: "1px solid var(--line)" }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button onClick={onOpenCart} className="kulto-btn relative p-2 rounded-full" style={{ color: "var(--bone)" }}>
            <ShoppingBag size={21} />
            {cartCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center" style={{ background: "var(--signal)", color: "var(--bone)" }}>
                {cartCount}
              </span>
            )}
          </button>
          <button className="md:hidden kulto-btn p-2 rounded-full" onClick={() => setOpen((o) => !o)} style={{ color: "var(--bone)" }} aria-label={open ? "Cerrar menú" : "Abrir menú"}>
            {open ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </div>
      {open && (
        <div className="md:hidden px-4 pb-4 flex flex-col gap-3" style={{ borderTop: "1px solid var(--line)" }}>
          <div className="sm:hidden flex items-center justify-center gap-1 rounded-full px-1.5 py-1 mt-3 self-center" style={{ border: "1px solid var(--line)" }}>
            <button
              onClick={onDecreaseFont}
              disabled={fontStep <= 0}
              className="kulto-btn w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
              style={{ color: fontStep <= 0 ? "var(--slate)" : "var(--bone)" }}
              aria-label="Achicar el tamaño de letra"
              title="Achicar letra"
            >
              A-
            </button>
            <span className="text-xs px-1 select-none" style={{ color: "var(--slate)" }} aria-hidden="true">Aa</span>
            <button
              onClick={onIncreaseFont}
              disabled={fontStep >= 3}
              className="kulto-btn w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold"
              style={{ color: fontStep >= 3 ? "var(--slate)" : "var(--bone)" }}
              aria-label="Agrandar el tamaño de letra"
              title="Agrandar letra"
            >
              A+
            </button>
          </div>
          <NavLink label="Inicio" active={page === "home"} onClick={() => go("home")} />
          <div>
            <button
              onClick={() => setCatalogMenuOpenMobile((o) => !o)}
              className="kulto-btn text-sm font-semibold pb-1 flex items-center gap-1 w-full"
              style={{ color: "var(--bone)", borderBottom: page === "catalog" ? "2px solid var(--signal)" : "2px solid transparent" }}
            >
              Productos <ChevronDown size={14} style={{ transform: catalogMenuOpenMobile ? "rotate(180deg)" : "none" }} />
            </button>
            {catalogMenuOpenMobile && (
              <div className="flex flex-col mt-2 ml-2 pl-3" style={{ borderLeft: "1px solid var(--line)" }}>
                <button onClick={() => goCatalog(null)} className="kulto-btn text-left py-2 text-sm" style={{ color: "var(--slate)" }}>
                  Catálogo
                </button>
                {productsMenuItems.map((it) => (
                  <React.Fragment key={it.id}>
                    <div style={{ height: 1, background: "var(--line)" }} />
                    <button onClick={() => goCatalog(it)} className="kulto-btn text-left py-2 text-sm" style={{ color: "var(--slate)" }}>
                      {it.label || it.value}
                    </button>
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
          <NavLink label="Personalizar" active={page === "wizard"} onClick={() => go("wizard")} />
          <NavLink label="Mi pedido" active={page === "seguimiento"} onClick={() => go("seguimiento")} />
          {customer && <NavLink label="Favoritos" active={page === "favoritos"} onClick={() => go("favoritos")} />}
          <NavLink label={customer ? "Mi cuenta" : "Ingresar"} active={page === "cuenta"} onClick={() => go("cuenta")} />
        </div>
      )}
    </header>
  );
}

function MarqueeStrip() {
  const words = ["Sublimado a color completo", "Diseños originales", "Personaliza tu prenda", "Pide por WhatsApp"];
  const track = [...words, ...words];
  return (
    <div className="overflow-hidden" style={{ background: "var(--signal)", borderBottom: "1px solid var(--line)" }}>
      <div className="kulto-marquee-track py-2">
        {track.map((w, i) => (
          <span key={i} className="kulto-display text-xs whitespace-nowrap px-6" style={{ color: "var(--bone)" }}>
            {w} <span style={{ color: "var(--ink)" }}>·</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function AbandonedCartBanner({ hours, count, onView, onDismiss }) {
  return (
    <div className="px-4 md:px-6 py-3" style={{ background: "var(--sun)" }}>
      <div className="max-w-6xl mx-auto flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm font-semibold" style={{ color: "var(--ink)" }}>
          Tienes {count} producto{count === 1 ? "" : "s"} guardado{count === 1 ? "" : "s"} en tu carrito desde hace {hours >= 24 ? `${Math.floor(hours / 24)} día(s)` : `${hours} h`}. ¿Seguimos con la compra?
        </p>
        <div className="flex items-center gap-2">
          <button onClick={onView} className="kulto-btn text-sm font-semibold px-4 py-1.5 rounded-full" style={{ background: "var(--ink)", color: "var(--bone)" }}>Ver carrito</button>
          <button onClick={onDismiss} className="kulto-btn p-1.5 rounded-full" style={{ color: "var(--ink)" }} aria-label="Cerrar aviso"><X size={16} /></button>
        </div>
      </div>
    </div>
  );
}

// Motivos típicos de una tienda de ropa — el admin no los edita, son fijos.
const CONTACT_SUBJECTS = ["Consulta general", "Estado de mi pedido", "Cambios y devoluciones", "Talles y medidas", "Otro"];

// El formulario de contacto en sí — se abre desde un ícono/botón "Contacto"
// en vez de mostrar el mail o el teléfono del dueño a la vista de cualquiera.
// Siempre manda el mail a ADMIN_EMAIL, que sendEmail() redirige de verdad a
// ADMIN_NOTIFICATION_EMAIL (ver arriba del archivo).
function ContactFormModal({ open, onClose, settings }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState(CONTACT_SUBJECTS[0]);
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("idle"); // idle | sending | sent
  const [error, setError] = useState("");

  if (!open) return null;

  const reset = () => { setName(""); setEmail(""); setSubject(CONTACT_SUBJECTS[0]); setMessage(""); setStatus("idle"); setError(""); };
  const close = () => { onClose(); setTimeout(reset, 300); };

  const submit = async () => {
    if (!name.trim() || !email.trim() || !message.trim()) {
      setError("Completá tu nombre, tu email y el mensaje.");
      return;
    }
    setStatus("sending");
    setError("");
    // Se guarda como ticket para que el admin lo vea y lo gestione desde el
    // panel (Contacto), y por las dudas también se manda el mail de aviso —
    // si el mail falla pero el guardado funcionó, igual queda registrado.
    const ticket = {
      id: genId("ctc"),
      name: name.trim(),
      email: email.trim(),
      subject,
      message: message.trim(),
      createdAt: Date.now(),
      status: "pendiente",
      changeDecision: "",
      discountPercent: null,
      discountCode: null,
      adminReply: "",
      repliedAt: null,
    };
    let saved = false;
    try {
      await persistContactMessage(ticket);
      saved = true;
    } catch { /* seguimos igual e intentamos el mail */ }
    const emailResult = await sendEmail({
      to: ADMIN_EMAIL,
      subject: `Contacto: ${subject}`,
      html: buildContactEmailHtml({ name: ticket.name, email: ticket.email, subject, message: ticket.message }, settings),
    });
    if (saved || emailResult.ok) {
      setStatus("sent");
    } else {
      setStatus("idle");
      setError(emailResult.error || "No se pudo enviar el mensaje. Probá de nuevo o escribinos por WhatsApp.");
    }
  };

  const inputStyle = { background: "var(--ink-3)", color: "var(--bone)", border: "1px solid var(--line)" };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={close}>
      <div onClick={(e) => e.stopPropagation()} className="rounded-2xl p-6 max-w-sm w-full" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
        <div className="flex items-center justify-between mb-4">
          <h4 className="font-semibold" style={{ color: "var(--bone)" }}>Contacto</h4>
          <button onClick={close} className="kulto-btn" style={{ color: "var(--slate)" }}><X size={18} /></button>
        </div>
        {status === "sent" ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Check size={32} style={{ color: "var(--sun)" }} />
            <p className="text-sm" style={{ color: "var(--bone)" }}>¡Listo! Recibimos tu mensaje, te respondemos a la brevedad.</p>
            <button onClick={close} className="kulto-btn text-sm mt-2 underline" style={{ color: "var(--slate)" }}>Cerrar</button>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <input placeholder="Tu nombre" value={name} onChange={(e) => setName(e.target.value)} className="rounded-xl p-2.5 text-sm" style={inputStyle} />
            <input type="email" placeholder="Tu email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-xl p-2.5 text-sm" style={inputStyle} />
            <select value={subject} onChange={(e) => setSubject(e.target.value)} className="rounded-xl p-2.5 text-sm" style={inputStyle}>
              {CONTACT_SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <textarea
              placeholder="Contanos en qué te podemos ayudar"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="rounded-xl p-2.5 text-sm resize-none"
              style={inputStyle}
            />
            {error && <p className="text-xs" style={{ color: "var(--signal)" }}>{error}</p>}
            <button
              onClick={submit}
              disabled={status === "sending"}
              className="kulto-btn rounded-full py-3 font-semibold flex items-center justify-center gap-2"
              style={{ background: "var(--signal)", color: "var(--bone)", opacity: status === "sending" ? 0.7 : 1 }}
            >
              {status === "sending" ? <><Loader2 size={16} className="animate-spin" /> Enviando…</> : "Enviar mensaje"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ContactSection({ settings }) {
  const sendHello = () => openWhatsApp("Hola Kulto, tengo una duda sobre un producto.");
  const [contactOpen, setContactOpen] = useState(false);
  return (
    <section id="contacto" className="max-w-6xl mx-auto px-4 md:px-6 py-16">
      <div className="rounded-3xl p-8 md:p-12 flex flex-col md:flex-row items-center justify-between gap-6" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
        <div>
          <h3 className="kulto-display text-2xl" style={{ color: "var(--bone)" }}>¿Tienes dudas?</h3>
          <p className="mt-2 max-w-sm" style={{ color: "var(--slate)" }}>Escríbenos directo a WhatsApp y te respondemos lo antes posible.</p>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <button onClick={() => setContactOpen(true)} className="kulto-btn text-sm flex items-center gap-2 w-fit" style={{ color: "var(--slate)" }}>
              <Mail size={15} /> Contacto
            </button>
            {settings?.contactAddress && (
              <span className="text-sm flex items-center gap-2" style={{ color: "var(--slate)" }}>
                <MapPin size={15} /> {settings.contactAddress}
              </span>
            )}
          </div>
        </div>
        <button onClick={sendHello} className="kulto-btn rounded-full px-6 py-3 font-semibold flex items-center gap-2 shrink-0" style={{ background: "var(--sun)", color: "var(--ink)" }}>
          <MessageCircle size={18} /> Escribir por WhatsApp
        </button>
      </div>
      <ContactFormModal open={contactOpen} onClose={() => setContactOpen(false)} settings={settings} />
    </section>
  );
}

function FaqSection({ settings }) {
  const items = settings?.faqItems || [];
  const [openId, setOpenId] = useState(null);
  if (!settings?.faqEnabled || !items.length) return null;
  return (
    <section id="faq" className="max-w-3xl mx-auto px-4 md:px-6 py-16">
      <SectionTitle eyebrow="¿Tenés dudas?" title="Preguntas frecuentes" />
      <div className="flex flex-col gap-2">
        {items.map((f) => (
          <div key={f.id} className="rounded-2xl overflow-hidden" style={{ background: "var(--ink-2)", border: "1px solid var(--line)" }}>
            <button
              onClick={() => setOpenId(openId === f.id ? null : f.id)}
              className="kulto-btn w-full flex items-center justify-between gap-3 text-left px-5 py-4"
              style={{ color: "var(--bone)" }}
            >
              <span className="text-sm font-semibold flex items-center gap-2"><HelpCircle size={16} style={{ color: "var(--signal)" }} /> {f.question}</span>
              <ChevronDown size={18} style={{ transform: openId === f.id ? "rotate(180deg)" : "none", transition: "transform .2s ease", flexShrink: 0 }} />
            </button>
            {openId === f.id && (
              <p className="text-sm px-5 pb-4" style={{ color: "var(--slate)" }}>{f.answer}</p>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

// El pie de página se arma en "items" (políticas, contacto, redes) en una
// sola fila que se acomoda sola — el texto largo de políticas ya no ocupa
// espacio fijo: queda como un link chico que abre una ventanita flotante
// con ese mismo texto, así el footer se mantiene bajo de altura.
function Footer({ settings }) {
  const [policyOpen, setPolicyOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const hasQuality = settings?.qualityPolicyEnabled && settings?.qualityPolicyText;
  const hasReturns = settings?.returnsPolicyEnabled && settings?.returnsPolicyText;
  const hasPolicies = hasQuality || hasReturns;

  const items = [];
  if (hasPolicies) {
    items.push(
      <button
        type="button"
        onClick={() => setPolicyOpen(true)}
        className="kulto-btn text-xs font-semibold underline"
        style={{ color: "var(--slate)" }}
      >
        Calidad y devoluciones
      </button>
    );
  }
  // El mail y el teléfono ya no se muestran directo acá — se piden por este
  // formulario, que manda a ADMIN_EMAIL (redirigido de verdad a la casilla
  // real del dueño, ver ADMIN_NOTIFICATION_EMAIL).
  items.push(
    <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs" style={{ color: "var(--slate)" }}>
      <button type="button" onClick={() => setContactOpen(true)} className="kulto-btn flex items-center gap-1.5" style={{ color: "var(--slate)" }}>
        <Mail size={13} /> Contacto
      </button>
      {settings.contactAddress && <span className="flex items-center gap-1.5"><MapPin size={13} /> {settings.contactAddress}</span>}
    </div>
  );
  // WhatsApp siempre se muestra (es el mismo número que usa todo el sitio
  // para abrir el chat) — las redes son opcionales, según lo que cargue el admin.
  items.push(
    <div className="flex items-center gap-4">
      {settings.socialInstagram && (
        <a href={settings.socialInstagram} target="_blank" rel="noreferrer" className="kulto-btn" style={{ color: "var(--slate)" }} title="Instagram"><Instagram size={18} /></a>
      )}
      <a href={`https://wa.me/${WHATSAPP_NUMBER}`} target="_blank" rel="noreferrer" className="kulto-btn" style={{ color: "var(--slate)" }} title="WhatsApp"><MessageCircle size={18} /></a>
      {settings.socialFacebook && (
        <a href={settings.socialFacebook} target="_blank" rel="noreferrer" className="kulto-btn" style={{ color: "var(--slate)" }} title="Facebook"><Facebook size={18} /></a>
      )}
      {settings.socialTiktok && (
        <a href={settings.socialTiktok} target="_blank" rel="noreferrer" className="kulto-btn" style={{ color: "var(--slate)" }} title="TikTok"><Music2 size={18} /></a>
      )}
    </div>
  );

  return (
    <footer className="px-4 md:px-6 py-6" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="max-w-3xl mx-auto flex flex-wrap items-center justify-center gap-x-5 gap-y-3">
        {items.map((item, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="w-px h-5" style={{ background: "var(--line)" }} />}
            {item}
          </React.Fragment>
        ))}
      </div>
      <div className="mt-4 text-center">
        <span className="kulto-display text-sm" style={{ color: "var(--slate)" }}>KULTO</span>
      </div>
      {policyOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.65)" }} onClick={() => setPolicyOpen(false)}>
          <div onClick={(e) => e.stopPropagation()} className="rounded-2xl p-6 max-w-sm w-full" style={{ background: "var(--ink)", border: "1px solid var(--line)" }}>
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-sm" style={{ color: "var(--bone)" }}>Calidad y devoluciones</h4>
              <button onClick={() => setPolicyOpen(false)} className="kulto-btn" style={{ color: "var(--slate)" }}><X size={18} /></button>
            </div>
            <div className="flex flex-col gap-3">
              {hasQuality && <p className="text-xs leading-relaxed" style={{ color: "var(--slate)" }}>{settings.qualityPolicyText}</p>}
              {hasReturns && <p className="text-xs leading-relaxed" style={{ color: "var(--slate)" }}>{settings.returnsPolicyText}</p>}
            </div>
          </div>
        </div>
      )}
      <ContactFormModal open={contactOpen} onClose={() => setContactOpen(false)} settings={settings} />
    </footer>
  );
}

function WhatsAppFloat({ liftForMobileBar }) {
  return (
    <button
      onClick={() => openWhatsApp("Hola Kulto, tengo una duda sobre un producto.")}
      className={`kulto-btn fixed right-5 z-30 w-14 h-14 rounded-full flex items-center justify-center ${liftForMobileBar ? "bottom-24 md:bottom-5" : "bottom-5"}`}
      style={{ background: "var(--sun)", color: "var(--ink)", boxShadow: "0 8px 20px rgba(0,0,0,0.4)" }}
      title="Escríbenos por WhatsApp"
    >
      <MessageCircle size={26} />
    </button>
  );
}

function MobileCartBar({ count, total, onOpen }) {
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-30 px-4 py-3" style={{ background: "var(--ink-2)", borderTop: "1px solid var(--line)" }}>
      <button onClick={onOpen} className="kulto-btn w-full rounded-full py-3 px-4 font-semibold flex items-center justify-between" style={{ background: "var(--signal)", color: "var(--bone)" }}>
        <span className="flex items-center gap-2"><ShoppingBag size={18} /> {count} artículo{count === 1 ? "" : "s"}</span>
        <span>{formatPrice(total)} · Ver carrito</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState(DEFAULT_CATEGORIES);
  const [groups, setGroups] = useState(DEFAULT_GROUPS);
  const [orders, setOrders] = useState([]);
  const [draftProducts, setDraftProducts] = useState([]);
  const [draftCategories, setDraftCategories] = useState(DEFAULT_CATEGORIES);
  const [draftGroups, setDraftGroups] = useState(DEFAULT_GROUPS);
  const [hasDraftChanges, setHasDraftChanges] = useState(false);
  const [photoInbox, setPhotoInbox] = useState([]);
  const [savedColors, setSavedColors] = useState([]);
  const [designLibrary, setDesignLibrary] = useState([]);
  const [designFolders, setDesignFolders] = useState([]);
  const [customWorkGallery, setCustomWorkGallery] = useState([]);
  const [publishing, setPublishing] = useState(false);
  const [reviews, setReviews] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  // Accesibilidad: modo claro/oscuro y tamaño de letra — elección de cada
  // visitante, guardada en su propio navegador (no es configuración de la
  // tienda). "fontStep" va de 0 (normal) a 3 (el más grande).
  const FONT_SCALES = [1, 1.15, 1.3, 1.45];
  const [themeMode, setThemeMode] = useState(() => {
    try { return localStorage.getItem("kulto:themeMode") || "dark"; } catch { return "dark"; }
  });
  const [fontStep, setFontStep] = useState(() => {
    try { return Number(localStorage.getItem("kulto:fontStep")) || 0; } catch { return 0; }
  });
  useEffect(() => {
    try { localStorage.setItem("kulto:themeMode", themeMode); } catch { /* localStorage puede estar bloqueado */ }
  }, [themeMode]);
  useEffect(() => {
    try { localStorage.setItem("kulto:fontStep", String(fontStep)); } catch { /* localStorage puede estar bloqueado */ }
    try { document.documentElement.style.fontSize = `${FONT_SCALES[fontStep] * 100}%`; } catch { /* nunca romper la página por esto */ }
  }, [fontStep]);
  const toggleThemeMode = () => setThemeMode((m) => (m === "light" ? "dark" : "light"));
  const decreaseFont = () => setFontStep((s) => Math.max(0, s - 1));
  const increaseFont = () => setFontStep((s) => Math.min(FONT_SCALES.length - 1, s + 1));

  const [page, setPage] = useState("home");
  // Al cambiar de página (por ejemplo, al tocar el botón de un banner) el
  // navegador no reinicia el scroll solo — si la página anterior estaba
  // scrolleada, la nueva podía arrancar mostrando el medio o el final en vez
  // de arriba de todo. Forzamos volver arriba en cada cambio de página.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  // Link del mail "Pedir reseña" (?review=KULTO-...): lleva directo a "Mi
  // pedido" con el número ya cargado, sin que el cliente tenga que escribirlo.
  const [reviewDeepLinkOrderId, setReviewDeepLinkOrderId] = useState("");
  // Link del mail "Recuperar contraseña" (?resetEmail=&resetCode=): lleva
  // directo a "Mi cuenta" con el formulario de contraseña nueva ya armado.
  const [resetDeepLinkEmail, setResetDeepLinkEmail] = useState("");
  const [resetDeepLinkCode, setResetDeepLinkCode] = useState("");
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const review = params.get("review");
      if (review) {
        setReviewDeepLinkOrderId(review);
        setPage("seguimiento");
      }
      const resetEmail = params.get("resetEmail");
      const resetCode = params.get("resetCode");
      if (resetEmail && resetCode) {
        setResetDeepLinkEmail(resetEmail);
        setResetDeepLinkCode(resetCode);
        setPage("cuenta");
      }
    } catch { /* nunca romper la carga de la web por esto */ }
  }, []);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState("");
  const [catalogInitialGroup, setCatalogInitialGroup] = useState("");
  const [catalogInitialCategory, setCatalogInitialCategory] = useState("");
  // Compartida entre el header (menú "Productos", ahora puede filtrar por
  // categoría además de por grupo), el inicio y los banners — lleva al
  // catálogo ya filtrado, o sin filtro si no se pasa nada. Acepta tanto un
  // string suelto (un grupo, como usan los banners de siempre) como un
  // objeto { group, category } (como usa el menú "Productos" del header).
  const goToCatalog = (filter) => {
    const f = typeof filter === "string" ? { group: filter } : (filter || {});
    setCatalogInitialGroup(f.group || "");
    setCatalogInitialCategory(f.category || "");
    setCatalogSearchQuery("");
    setPage("catalog");
  };
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [cart, setCart] = useState([]);
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");
  const [comment, setComment] = useState("");
  const [deliveryMethod, setDeliveryMethod] = useState("recogida");
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [sending, setSending] = useState(false);
  const [confirmedOrderId, setConfirmedOrderId] = useState(null);
  const [confirmedHasCustom, setConfirmedHasCustom] = useState(false);
  const [cartSavedAt, setCartSavedAt] = useState(null);
  const [showAbandonedBanner, setShowAbandonedBanner] = useState(false);

  const [customer, setCustomer] = useState(null); // cuenta de cliente logueada (distinta del formulario de checkout)
  const [customersList, setCustomersList] = useState([]); // para el panel admin — todas las cuentas registradas
  // Si el mail de la cuenta logueada es el de ADMIN_EMAIL, "Mi cuenta" muestra
  // el panel de administrador en vez de la cuenta de cliente normal.
  const isAdminAccount = !!customer && normalizeEmail(customer.email) === normalizeEmail(ADMIN_EMAIL);
  // Cuenta de cliente a la que el dueño le dio acceso limitado al panel (ver
  // AdminCustomers → "Permisos"). Nunca puede ser el propio ADMIN_EMAIL — ese
  // ya entra como dueño con todo el acceso más arriba.
  const isSubAdminAccount = !!customer && !isAdminAccount && Array.isArray(customer.adminPermissions) && customer.adminPermissions.length > 0;
  const hasAdminAccess = isAdminAccount || isSubAdminAccount;
  const adminPermissionsForAccount = isAdminAccount ? ADMIN_TAB_KEYS : (customer?.adminPermissions || []);
  // Para no correr la migración de fotos viejas más de una vez por sesión
  // (por ejemplo, cada vez que el admin entra y sale de "Mi cuenta").
  const legacyImagesMigratedRef = useRef(false);
  // Igual, pero para agregar la paleta de colores de Roly 2026 a la librería
  // de colores guardados una sola vez por sesión.
  const rolyColorsSeededRef = useRef(false);

  // Vista "como cliente" para el admin: navega todo el sitio (inicio,
  // catálogo, personalizar, mi pedido, favoritos, mi cuenta) tal como lo vería
  // un cliente real, sin cerrar la sesión de administrador. El botón
  // "Volver al panel" (más abajo) apaga esta vista.
  const [previewAsCustomer, setPreviewAsCustomer] = useState(false);
  useEffect(() => {
    if (!hasAdminAccess) setPreviewAsCustomer(false);
  }, [hasAdminAccess]);
  const effectiveAdminView = hasAdminAccess && !previewAsCustomer;

  // El menú de accesos rápidos (9 puntos) del header pide saltar a una
  // pestaña puntual del panel de administrador (Ventas, Compras, etc.).
  const [adminTabRequest, setAdminTabRequest] = useState(null);
  const jumpToAdminTab = (tabKey) => {
    setPreviewAsCustomer(false);
    setPage("cuenta");
    setAdminTabRequest({ tab: tabKey, at: Date.now() });
  };

  // Cierre de sesión automático del administrador tras 15 minutos sin
  // actividad (clicks, teclado, scroll, toques) — el panel queda accesible
  // desde cualquier navegador que haya iniciado sesión, así que conviene
  // cerrarla sola si quedó olvidada abierta.
  const adminLastActivityRef = useRef(Date.now());
  useEffect(() => {
    if (!hasAdminAccess) return;
    const markActivity = () => { adminLastActivityRef.current = Date.now(); };
    const events = ["mousedown", "keydown", "touchstart", "scroll"];
    events.forEach((ev) => window.addEventListener(ev, markActivity, { passive: true }));
    markActivity();
    const IDLE_LIMIT_MS = 15 * 60 * 1000;
    const interval = setInterval(() => {
      if (Date.now() - adminLastActivityRef.current > IDLE_LIMIT_MS) {
        handleLogoutCustomer();
        setPreviewAsCustomer(false);
        setPage("home");
      }
    }, 30 * 1000);
    return () => {
      events.forEach((ev) => window.removeEventListener(ev, markActivity));
      clearInterval(interval);
    };
  }, [hasAdminAccess]);

  useEffect(() => {
    (async () => {
      const [prods, cats, grps, cartState, sett, revs, designs, folders, customWork, customerSessionEmail] = await Promise.all([
        loadProducts(), loadCategories(), loadGroups(), loadCartState(), loadSettings(), loadReviews(), loadDesignLibrary(), loadDesignFolders(), loadCustomWorkGallery(), storageGet("kulto:customer-session", false),
      ]);
      if (customerSessionEmail) {
        loadCustomer(customerSessionEmail).then((c) => { if (c) setCustomer(c); });
      }
      setProducts(prods);
      setCategories(cats);
      setGroups(grps);
      setSettings(sett);
      setReviews(revs);
      setDesignLibrary(designs);
      setDesignFolders(folders);
      setCustomWorkGallery(customWork);
      setCart(cartState.items || []);
      setCustomerEmail(cartState.email || "");
      setCustomerName(cartState.name || "");
      setCustomerPhone(cartState.phone || "");
      setDeliveryMethod(cartState.deliveryMethod || "recogida");
      setAddress(cartState.address && typeof cartState.address === "object" ? { ...EMPTY_ADDRESS, ...cartState.address } : EMPTY_ADDRESS);
      setCartSavedAt(cartState.savedAt || null);
      if (cartState.items && cartState.items.length && hoursSince(cartState.savedAt) >= ABANDONED_HOURS) {
        setShowAbandonedBanner(true);
      }
      setLoading(false);
    })();
  }, []);

  // Track when the cart first got items, so we can tell how "abandoned" it is.
  useEffect(() => {
    if (loading) return;
    if (cart.length > 0 && !cartSavedAt) setCartSavedAt(Date.now());
    if (cart.length === 0 && cartSavedAt) setCartSavedAt(null);
  }, [cart, loading, cartSavedAt]);

  useEffect(() => {
    if (loading) return;
    persistCartState({
      items: cart, email: customerEmail, name: customerName, phone: customerPhone,
      deliveryMethod, address, savedAt: cartSavedAt,
    });
  }, [cart, customerEmail, customerName, customerPhone, deliveryMethod, address, cartSavedAt, loading]);

  useEffect(() => {
    if (page === "cuenta" && hasAdminAccess) {
      loadOrders().then(setOrders);
      loadAllCustomers().then(setCustomersList);
      Promise.all([loadDraftProducts(), loadDraftCategories(), loadDraftGroups(), checkDraftChanges(), loadPhotoInbox(), loadSavedColors()]).then(
        ([dProds, dCats, dGroups, changed, inbox, colors]) => {
          setDraftProducts(dProds);
          setDraftCategories(dCats);
          setDraftGroups(dGroups);
          setHasDraftChanges(changed);
          setPhotoInbox(inbox);
          setSavedColors(colors);
          // Migración de fotos viejas a Storage — una sola vez por sesión, en
          // segundo plano, sin bloquear nada de lo que el admin esté viendo.
          // Si el bucket todavía no existe, no hace nada (lo intentará de
          // nuevo la próxima vez que se entre a "Mi cuenta").
          if (!legacyImagesMigratedRef.current) {
            legacyImagesMigratedRef.current = true;
            migrateLegacyImages({ products, draftProducts: dProds, designLibrary, customWorkGallery }).catch(() => {});
          }
          // Suma la paleta de Roly 2026 a la librería de colores guardados,
          // una sola vez por sesión, sin pisar ni duplicar nada.
          if (!rolyColorsSeededRef.current) {
            rolyColorsSeededRef.current = true;
            seedRolyColorsIfNeeded(colors).then((next) => { if (next !== colors) setSavedColors(next); }).catch(() => {});
          }
        }
      );
    }
  }, [page, hasAdminAccess]);

  // Keep the browser tab icon in sync with whatever logo is set in Ajustes.
  useEffect(() => {
    if (!settings.logoImage) return;
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = settings.logoImage;
  }, [settings.logoImage]);

  const cartCount = cart.reduce((s, it) => s + it.qty, 0);
  // Los productos marcados "oculto" por el admin (ver botón Ocultar/Mostrar
  // en el panel) no deben aparecer para el cliente en ningún lado — inicio,
  // catálogo, buscador, ficha de producto — pero siguen existiendo (stock,
  // pedidos viejos que los referencian, etc.) y el admin los sigue viendo
  // en su panel para poder mostrarlos de nuevo cuando quiera.
  const sellableProducts = products.filter((p) => !p.tags?.template && !p.hidden);

  const handleAddToCart = useCallback((item) => {
    setCart((prev) => [...prev, item]);
  }, []);

  const handleUpdateQty = (cartId, qty) => setCart((prev) => prev.map((it) => (it.cartId === cartId ? { ...it, qty } : it)));
  const handleRemove = (cartId) => setCart((prev) => prev.filter((it) => it.cartId !== cartId));

  const handleCheckout = async ({ subtotal, shippingCost, total, discountAmount = 0, itemCount = 0 }) => {
    if (cart.length === 0) return;
    setSending(true);
    const order = {
      id: `KULTO-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
      date: new Date().toISOString(),
      items: cart,
      customerName, customerPhone, customerEmail, comment,
      deliveryMethod, address: deliveryMethod === "envio" ? address : null,
      subtotal, shippingCost, total, discountAmount,
      customerAccountEmail: customer?.email || null,
      status: "pendiente",
      trackingNumber: "",
      archived: false,
    };
    // Abrimos WhatsApp ANTES de esperar cualquier guardado — si dejamos pasar
    // varios "await" en el medio, algunos navegadores de celular (sobre todo
    // Safari de iPhone) bloquean la ventana emergente por no considerarla ya
    // una acción directa del toque del cliente.
    openWhatsApp(buildOrderMessage(order, settings));
    try {
      await persistOrder(order);
    } catch {
      try { await persistOrder(order); } catch { /* still proceed — el pedido ya se mandó por WhatsApp */ }
    }
    if (order.customerEmail) {
      sendEmail({
        to: order.customerEmail,
        subject: `Confirmamos tu pedido ${order.id}`,
        html: buildOrderEmailHtml(order, settings),
      }).catch(() => { /* nunca bloquear el checkout por esto */ });
    }
    if (customer) {
      try {
        const pointsEarned = settings?.loyaltyEnabled
          ? cart.reduce((s, it) => s + it.qty * (Number(it.points ?? settings.loyaltyPointsPerItem) || 0), 0)
          : 0;
        const updatedCustomer = {
          ...customer,
          points: (customer.points || 0) + pointsEarned,
          firstDiscountUsed: discountAmount > 0 ? true : customer.firstDiscountUsed,
        };
        await persistCustomer(updatedCustomer);
        setCustomer(updatedCustomer);
      } catch { /* nunca bloquear el checkout por esto */ }
    }
    try {
      const salesByProduct = {};
      cart.forEach((it) => { salesByProduct[it.productId] = (salesByProduct[it.productId] || 0) + it.qty; });
      const updates = Object.entries(salesByProduct).map(async ([productId, qty]) => {
        const p = products.find((pr) => pr.id === productId);
        if (!p) return null;
        const updated = { ...p, salesCount: (p.salesCount || 0) + qty };
        await persistProduct(updated);
        return updated;
      });
      const updatedProducts = (await Promise.all(updates)).filter(Boolean);
      if (updatedProducts.length) {
        setProducts((prev) => prev.map((p) => updatedProducts.find((u) => u.id === p.id) || p));
      }
    } catch { /* sales count is a nice-to-have; never block checkout on it */ }
    setCart([]);
    setComment("");
    setCartSavedAt(null);
    setShowAbandonedBanner(false);
    setSending(false);
    setCartOpen(false);
    setConfirmedOrderId(order.id);
    setConfirmedHasCustom(order.items.some((it) => it.designName?.startsWith("Personalizado")));
  };

  const handleSaveProduct = async (product) => {
    await persistDraftProduct(product);
    await markDraftChanged();
    setHasDraftChanges(true);
    setDraftProducts((prev) => {
      const exists = prev.some((p) => p.id === product.id);
      return exists ? prev.map((p) => (p.id === product.id ? product : p)) : [...prev, product];
    });
  };

  const handleDeleteProduct = async (id) => {
    await removeDraftProduct(id);
    await markDraftChanged();
    setHasDraftChanges(true);
    setDraftProducts((prev) => prev.filter((p) => p.id !== id));
  };

  // Suma una vista al contador de un producto cada vez que un cliente abre su
  // ficha — igual que salesCount, se escribe directo sobre el producto
  // publicado (nunca sobre el borrador) para que se vea al toque sin tener
  // que "Publicar cambios", y nunca debe frenar la navegación si falla.
  const handleTrackProductView = async (productId) => {
    try {
      const p = products.find((pr) => pr.id === productId);
      if (!p) return;
      const updated = { ...p, viewsCount: (p.viewsCount || 0) + 1 };
      await persistProduct(updated);
      setProducts((prev) => prev.map((pr) => (pr.id === productId ? updated : pr)));
    } catch { /* la vista es un nice-to-have, nunca debe romper la navegación */ }
  };

  const handleAddCategory = async (name) => {
    if (draftCategories.includes(name)) return;
    const next = [...draftCategories, name];
    setDraftCategories(next);
    await persistDraftCategories(next);
    await markDraftChanged();
    setHasDraftChanges(true);
  };

  const handleRenameCategory = async (oldName, newName) => {
    if (!newName || newName === oldName || draftCategories.includes(newName)) return;
    const next = draftCategories.map((c) => (c === oldName ? newName : c));
    setDraftCategories(next);
    await persistDraftCategories(next);
    const affected = draftProducts.filter((p) => p.category === oldName);
    const updated = affected.map((p) => ({ ...p, category: newName }));
    if (updated.length) {
      await Promise.all(updated.map((p) => persistDraftProduct(p)));
      setDraftProducts((prev) => prev.map((p) => updated.find((u) => u.id === p.id) || p));
    }
    await markDraftChanged();
    setHasDraftChanges(true);
  };

  const handleDeleteCategory = async (name) => {
    const inUse = draftProducts.some((p) => p.category === name);
    if (inUse) return { ok: false, reason: "en-uso" };
    const next = draftCategories.filter((c) => c !== name);
    setDraftCategories(next);
    await persistDraftCategories(next);
    await markDraftChanged();
    setHasDraftChanges(true);
    return { ok: true };
  };

  const handleAddGroup = async (name) => {
    if (draftGroups.includes(name)) return;
    const next = [...draftGroups, name];
    setDraftGroups(next);
    await persistDraftGroups(next);
    await markDraftChanged();
    setHasDraftChanges(true);
  };

  const handleRenameGroup = async (oldName, newName) => {
    if (!newName || newName === oldName || draftGroups.includes(newName)) return;
    const next = draftGroups.map((g) => (g === oldName ? newName : g));
    setDraftGroups(next);
    await persistDraftGroups(next);
    const affected = draftProducts.filter((p) => p.group === oldName);
    const updated = affected.map((p) => ({ ...p, group: newName }));
    if (updated.length) {
      await Promise.all(updated.map((p) => persistDraftProduct(p)));
      setDraftProducts((prev) => prev.map((p) => updated.find((u) => u.id === p.id) || p));
    }
    await markDraftChanged();
    setHasDraftChanges(true);
  };

  const handleDeleteGroup = async (name) => {
    const inUse = draftProducts.some((p) => p.group === name);
    if (inUse) return { ok: false, reason: "en-uso" };
    const next = draftGroups.filter((g) => g !== name);
    setDraftGroups(next);
    await persistDraftGroups(next);
    await markDraftChanged();
    setHasDraftChanges(true);
    return { ok: true };
  };

  const handlePublishChanges = async () => {
    setPublishing(true);
    const previousProducts = products;
    await publishDraft();
    const [freshProducts, freshCategories, freshGroups] = await Promise.all([loadProducts(), loadCategories(), loadGroups()]);
    // Si algún producto pasó de sin stock a con stock al publicar, les
    // avisamos por mail a todos los que pidieron que les avisen (ver
    // RestockNotifyForm) — nunca bloquea la publicación si algo falla acá.
    freshProducts.forEach((p) => {
      const prev = previousProducts.find((pp) => pp.id === p.id);
      if (prev && (prev.stock ?? 0) <= 0 && (p.stock ?? 0) > 0) {
        notifyRestockSubscribers(p.id, p.name, settings).catch(() => {});
      }
    });
    setProducts(freshProducts);
    setCategories(freshCategories);
    setGroups(freshGroups);
    setHasDraftChanges(false);
    setPublishing(false);
  };

  // Sumar stock desde el apartado "Compras" es una operación chica y urgente
  // (llegó la mercadería, hay que reflejarlo ya) — por eso escribe directo
  // sobre el producto publicado, igual que salesCount/viewsCount, en vez de
  // pasar por el ciclo de borrador/"Publicar cambios". Si el producto también
  // tiene un borrador pendiente, le actualizamos el stock ahí también para
  // que no queden desincronizados. Si el stock pasa de 0 para arriba, avisa
  // por mail a quienes pidieron que les notifiquen (igual que al publicar).
  const handleQuickRestock = async (productId, addAmount) => {
    const p = products.find((pr) => pr.id === productId);
    if (!p) return;
    const wasOut = (p.stock ?? 0) <= 0;
    const updated = { ...p, stock: (p.stock ?? 0) + addAmount };
    await persistProduct(updated);
    setProducts((prev) => prev.map((pr) => (pr.id === productId ? updated : pr)));
    const draftMatch = draftProducts.find((pr) => pr.id === productId);
    if (draftMatch) {
      const updatedDraft = { ...draftMatch, stock: updated.stock };
      await persistDraftProduct(updatedDraft).catch(() => {});
      setDraftProducts((prev) => prev.map((pr) => (pr.id === productId ? updatedDraft : pr)));
    }
    if (wasOut && updated.stock > 0) {
      notifyRestockSubscribers(productId, p.name, settings).catch(() => {});
    }
  };

  const handleDiscardChanges = async () => {
    await discardDraft();
    const [dProds, dCats, dGroups] = await Promise.all([loadDraftProducts(), loadDraftCategories(), loadDraftGroups()]);
    setDraftProducts(dProds);
    setDraftCategories(dCats);
    setDraftGroups(dGroups);
    setHasDraftChanges(false);
  };

  const fileToBase64Promise = (file, maxDim, quality, format) =>
    new Promise((resolve) => fileToBase64(file, resolve, maxDim, quality, format));

  const handleAddToInbox = async (files) => {
    const list = Array.from(files);
    const items = await Promise.all(
      list.map(async (f) => {
        const isPng = f.type === "image/png";
        const b64 = await fileToBase64Promise(f, 1200, isPng ? 1 : 0.85, isPng ? "image/png" : "image/jpeg");
        return { id: genId("img"), image: b64 };
      })
    );
    setPhotoInbox((prev) => {
      const next = [...prev, ...items];
      persistPhotoInbox(next);
      return next;
    });
  };

  const handleRemoveFromInbox = (ids) => {
    setPhotoInbox((prev) => {
      const next = prev.filter((i) => !ids.includes(i.id));
      persistPhotoInbox(next);
      return next;
    });
  };

  const handleSaveColorToLibrary = (color) => {
    setSavedColors((prev) => {
      const exists = prev.some((c) => c.name.toLowerCase() === color.name.toLowerCase() && c.hex.toLowerCase() === color.hex.toLowerCase());
      if (exists) return prev;
      const next = [...prev, { name: color.name, hex: color.hex }];
      persistSavedColors(next);
      return next;
    });
  };

  // Genera un código de 6 dígitos, lo guarda en la cuenta (vence en 15 min) y
  // manda el mail. Se usa tanto al registrarse como para "reenviar código".
  const issueAndSendVerification = async (customerRecord) => {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const updated = { ...customerRecord, emailVerified: false, verificationCode: code, verificationExpires: Date.now() + 15 * 60 * 1000 };
    await persistCustomer(updated);
    const emailResult = await sendEmail({
      to: updated.email,
      subject: `Confirmá tu cuenta en ${settings?.logoText || "Kulto"}`,
      html: buildVerificationEmailHtml(updated.name, code, settings),
    });
    return { record: updated, emailSent: emailResult.ok, emailError: emailResult.error };
  };

  const handleRegisterCustomer = async ({ name, email, password }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (existing) return { ok: false, error: "Ya existe una cuenta con ese email — probá iniciar sesión." };
    const passwordHash = await hashPassword(password);
    const record = { id: genId("cu"), name: name.trim(), email: norm, passwordHash, points: 0, firstDiscountUsed: false, createdAt: Date.now() };
    // La cuenta de administrador (ADMIN_EMAIL) entra directo, sin confirmar
    // mail — así el dueño de la tienda nunca queda afuera de su propio panel
    // por no tener todavía el envío de mails configurado.
    if (norm === normalizeEmail(ADMIN_EMAIL)) {
      const adminRecord = { ...record, emailVerified: true };
      await persistCustomer(adminRecord);
      await storageSet("kulto:customer-session", norm, false);
      setCustomer(adminRecord);
      return { ok: true };
    }
    const { emailSent, emailError } = await issueAndSendVerification(record);
    return {
      ok: true,
      needsVerification: true,
      email: norm,
      error: emailSent ? "" : `Creamos tu cuenta pero no pudimos mandarte el mail de confirmación (${emailError || "revisá la config del servidor"}). Probá "Reenviar código" en un rato.`,
    };
  };

  const handleVerifyEmail = async ({ email, code }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (!existing) return { ok: false, error: "No encontramos esa cuenta." };
    if (existing.emailVerified !== false) {
      await storageSet("kulto:customer-session", norm, false);
      setCustomer(existing);
      return { ok: true };
    }
    if (!existing.verificationCode || (existing.verificationExpires || 0) < Date.now()) {
      return { ok: false, error: "El código venció. Pedí uno nuevo con \"Reenviar código\"." };
    }
    if (existing.verificationCode !== code.trim()) {
      return { ok: false, error: "El código no es correcto." };
    }
    const updated = { ...existing, emailVerified: true, verificationCode: null, verificationExpires: null };
    await persistCustomer(updated);
    await storageSet("kulto:customer-session", norm, false);
    setCustomer(updated);
    return { ok: true };
  };

  const handleResendVerification = async ({ email }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (!existing) return { ok: false, error: "No encontramos esa cuenta." };
    const { emailSent, emailError } = await issueAndSendVerification(existing);
    return emailSent ? { ok: true } : { ok: false, error: emailError || "No se pudo enviar el mail." };
  };

  // "Olvidé mi contraseña": mismo mecanismo que la verificación de mail (un
  // código de 6 dígitos que vence a los 15 minutos), pero guardado aparte
  // (resetCode/resetExpires) para no pisar un código de verificación de mail
  // pendiente si el cliente todavía no confirmó la cuenta.
  const handleRequestPasswordReset = async ({ email }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (!existing) return { ok: false, error: "No encontramos una cuenta con ese email." };
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const updated = { ...existing, resetCode: code, resetExpires: Date.now() + 15 * 60 * 1000 };
    await persistCustomer(updated);
    const emailResult = await sendEmail({
      to: updated.email,
      subject: `Recuperar tu contraseña en ${settings?.logoText || "Kulto"}`,
      html: buildPasswordResetEmailHtml(updated.name, code, settings, updated.email),
    });
    if (!emailResult.ok) return { ok: false, error: `No pudimos mandarte el mail (${emailResult.error || "revisá la config del servidor"}).` };
    return { ok: true };
  };

  const handleResetPassword = async ({ email, code, newPassword }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (!existing) return { ok: false, error: "No encontramos esa cuenta." };
    if (!existing.resetCode || (existing.resetExpires || 0) < Date.now()) {
      return { ok: false, error: "El código venció. Pedí uno nuevo con \"Reenviar código\"." };
    }
    if (existing.resetCode !== code.trim()) {
      return { ok: false, error: "El código no es correcto." };
    }
    const passwordHash = await hashPassword(newPassword);
    const updated = { ...existing, passwordHash, resetCode: null, resetExpires: null, emailVerified: true };
    await persistCustomer(updated);
    await storageSet("kulto:customer-session", norm, false);
    setCustomer(updated);
    return { ok: true };
  };

  const handleLoginCustomer = async ({ email, password }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (!existing) return { ok: false, error: "No encontramos una cuenta con ese email." };
    const passwordHash = await hashPassword(password);
    if (passwordHash !== existing.passwordHash) return { ok: false, error: "Contraseña incorrecta." };
    const isAdminAccount_ = norm === normalizeEmail(ADMIN_EMAIL);
    if (existing.emailVerified === false && !isAdminAccount_) {
      await issueAndSendVerification(existing);
      return { ok: false, needsVerification: true, email: norm, error: "Todavía no confirmaste tu mail — te mandamos un código nuevo." };
    }
    await storageSet("kulto:customer-session", norm, false);
    setCustomer(existing);
    return { ok: true };
  };

  const handleLogoutCustomer = async () => {
    await storageDelete("kulto:customer-session", false);
    setCustomer(null);
  };

  // "Me gusta" / favoritos — solo para clientes con cuenta, para que la lista
  // los siga sin importar desde qué dispositivo entren la próxima vez.
  const handleToggleFavorite = async (productId) => {
    if (!customer) { setPage("cuenta"); return; }
    const favs = customer.favorites || [];
    const next = favs.includes(productId) ? favs.filter((id) => id !== productId) : [...favs, productId];
    const updated = { ...customer, favorites: next };
    setCustomer(updated);
    await persistCustomer(updated);
  };

  const handleAdjustCustomerPoints = async (customerEmail_, newPoints) => {
    const target = customersList.find((c) => c.email === customerEmail_);
    if (!target) return;
    const updated = { ...target, points: Math.max(0, newPoints) };
    await persistCustomer(updated);
    setCustomersList((prev) => prev.map((c) => (c.email === customerEmail_ ? updated : c)));
    if (customer?.email === customerEmail_) setCustomer(updated);
  };

  // Le da (o le quita) a una cuenta de cliente acceso limitado al panel de
  // administrador — ver AdminCustomers → "Permisos". Solo el dueño llega acá
  // (la UI que llama a esto ni se muestra si no sos el dueño).
  const handleSetAdminPermissions = async (customerEmail_, permissions) => {
    const target = customersList.find((c) => c.email === customerEmail_);
    if (!target) return;
    const cleaned = (permissions || []).filter((k) => ADMIN_TAB_KEYS.includes(k));
    const updated = { ...target, adminPermissions: cleaned };
    await persistCustomer(updated);
    setCustomersList((prev) => prev.map((c) => (c.email === customerEmail_ ? updated : c)));
    if (customer?.email === customerEmail_) setCustomer(updated);
  };

  // Borra una cuenta de cliente. Nunca deja borrar la cuenta del dueño de la
  // tienda (ADMIN_EMAIL) para que no se pueda quedar afuera de su propio panel
  // por accidente.
  const handleDeleteCustomer = async (customerEmail_) => {
    if (normalizeEmail(customerEmail_) === normalizeEmail(ADMIN_EMAIL)) return;
    await removeCustomer(customerEmail_);
    setCustomersList((prev) => prev.filter((c) => c.email !== customerEmail_));
    if (customer?.email === customerEmail_) {
      setCustomer(null);
      try { await storageDelete("kulto:customer-session", false); } catch { /* nunca romper el borrado por esto */ }
    }
  };

  // Crea una cuenta a nombre de un cliente (ej: compró por WhatsApp y todavía
  // no tiene una) sin definirle contraseña — le llega el mismo mail de
  // "elegí tu contraseña" que usa la recuperación, así nunca la vemos.
  const handleAdminCreateCustomer = async ({ name, email }) => {
    const norm = normalizeEmail(email);
    const existing = await loadCustomer(norm);
    if (existing) return { ok: false, error: "Ya existe una cuenta con ese email." };
    const record = {
      id: genId("cu"), name: (name || "").trim(), email: norm,
      passwordHash: null, points: 0, firstDiscountUsed: false, createdAt: Date.now(),
      emailVerified: true, // la creó el admin a mano, no hace falta reconfirmar el mail
    };
    await persistCustomer(record);
    setCustomersList((prev) => [...prev, record]);
    const sendResult = await handleRequestPasswordReset({ email: norm });
    return sendResult.ok ? { ok: true } : { ok: true, error: `Se creó la cuenta pero no pudimos mandar el mail (${sendResult.error || "revisá la config del servidor"}). Podés reintentar con "Contraseña" en su fila.` };
  };

  // Deja que el admin corrija el nombre o el email de un cliente si algo
  // quedó mal cargado. El email es la clave de guardado de la cuenta, así que
  // si cambia hay que mudar el registro a la key nueva y borrar la vieja.
  const handleAdminUpdateCustomerInfo = async (oldEmail, { name, email }) => {
    const oldNorm = normalizeEmail(oldEmail);
    const newNorm = normalizeEmail(email);
    // La cuenta de ADMIN_EMAIL es la puerta de entrada al panel — cambiarle
    // el email por error dejaría al dueño afuera de su propia tienda.
    if (oldNorm === normalizeEmail(ADMIN_EMAIL) && newNorm !== oldNorm) {
      return { ok: false, error: "No podés cambiar el email de la cuenta principal de administrador." };
    }
    const existing = await loadCustomer(oldNorm);
    if (!existing) return { ok: false, error: "No encontramos esa cuenta." };
    if (newNorm !== oldNorm) {
      const clash = await loadCustomer(newNorm);
      if (clash) return { ok: false, error: "Ya hay otra cuenta con ese email." };
    }
    const updated = { ...existing, name: (name || "").trim(), email: newNorm };
    await persistCustomer(updated);
    if (newNorm !== oldNorm) await removeCustomer(oldNorm);
    setCustomersList((prev) => prev.map((c) => (c.email === oldNorm ? updated : c)));
    if (customer?.email === oldNorm) {
      setCustomer(updated);
      if (newNorm !== oldNorm) {
        try { await storageSet("kulto:customer-session", newNorm, false); } catch { /* no bloquea el guardado */ }
      }
    }
    return { ok: true };
  };

  const handleAddDesignToLibrary = async (design) => {
    const result = await persistDesignToLibrary(design);
    if (result.ok) setDesignLibrary((prev) => [...prev, design]);
    return result;
  };

  const handleRemoveDesignFromLibrary = async (id) => {
    await removeDesignFromLibrary(id);
    setDesignLibrary((prev) => prev.filter((d) => d.id !== id));
  };

  // Carpetas de la librería de diseños — agrupan diseños ya subidos para que
  // no quede todo en una sola grilla gigante. Cada diseño guarda a lo sumo
  // una carpeta (design.folderId); "portada" (coverDesignIds) es lo que se
  // ve desde afuera de la tarjeta sin entrar, elegido a mano por el admin.
  const handleAddDesignFolder = async (name, category = "") => {
    const folder = { id: genId("fld"), name: name.trim() || "Carpeta", coverDesignIds: [], category: category || "" };
    const next = [...designFolders, folder];
    setDesignFolders(next);
    await persistDesignFolders(next);
  };

  const handleRenameDesignFolder = async (id, name) => {
    const next = designFolders.map((f) => (f.id === id ? { ...f, name } : f));
    setDesignFolders(next);
    await persistDesignFolders(next);
  };

  // A qué categoría de producto quedan atados los diseños de esta carpeta
  // (ej: "Mates") — en "Personalizar" esa carpeta solo va a aparecer cuando
  // el cliente esté personalizando un producto de esa categoría. Dejarlo en
  // "" (Todas) hace que la carpeta se vea siempre, sin importar la prenda.
  const handleSetDesignFolderCategory = async (id, category) => {
    const next = designFolders.map((f) => (f.id === id ? { ...f, category: category || "" } : f));
    setDesignFolders(next);
    await persistDesignFolders(next);
  };

  const handleRemoveDesignFolder = async (id) => {
    const next = designFolders.filter((f) => f.id !== id);
    setDesignFolders(next);
    await persistDesignFolders(next);
    // Los diseños que estaban adentro no se borran, quedan sueltos otra vez.
    const affected = designLibrary.filter((d) => d.folderId === id);
    if (affected.length) {
      const updated = affected.map((d) => ({ ...d, folderId: null }));
      setDesignLibrary((prev) => prev.map((d) => (d.folderId === id ? { ...d, folderId: null } : d)));
      await Promise.all(updated.map((d) => persistDesignToLibrary(d)));
    }
  };

  const handleToggleDesignFolderCover = async (folderId, designId) => {
    const folder = designFolders.find((f) => f.id === folderId);
    if (!folder) return;
    const has = (folder.coverDesignIds || []).includes(designId);
    let coverDesignIds;
    if (has) {
      coverDesignIds = folder.coverDesignIds.filter((id) => id !== designId);
    } else {
      if ((folder.coverDesignIds || []).length >= 4) return; // ya eligió las 4
      coverDesignIds = [...(folder.coverDesignIds || []), designId];
    }
    const next = designFolders.map((f) => (f.id === folderId ? { ...f, coverDesignIds } : f));
    setDesignFolders(next);
    await persistDesignFolders(next);
  };

  const handleAssignDesignToFolder = async (designId, folderId) => {
    const design = designLibrary.find((d) => d.id === designId);
    if (!design) return;
    const updated = { ...design, folderId: folderId || null };
    setDesignLibrary((prev) => prev.map((d) => (d.id === designId ? updated : d)));
    await persistDesignToLibrary(updated);
  };

  const handleAddCustomWork = async (item) => {
    const result = await persistCustomWorkPhoto(item);
    if (result.ok) {
      setCustomWorkGallery((prev) =>
        prev.some((it) => it.id === item.id) ? prev.map((it) => (it.id === item.id ? item : it)) : [...prev, item]
      );
    }
    return result;
  };

  const handleRemoveCustomWork = async (id) => {
    await removeCustomWorkPhoto(id);
    setCustomWorkGallery((prev) => prev.filter((it) => it.id !== id));
  };

  const handleRemoveColorFromLibrary = (color) => {
    setSavedColors((prev) => {
      const next = prev.filter((c) => !(c.name === color.name && c.hex === color.hex));
      persistSavedColors(next);
      return next;
    });
  };

  const handleCreateProductFromInbox = async ({ name, category, group, price }, images, ids) => {
    const product = {
      ...emptyDraft,
      id: genId("p"),
      name,
      category,
      group: group || "",
      price: Number(price),
      photoPool: images,
      createdAt: Date.now(),
      salesCount: 0,
    };
    await handleSaveProduct(product);
    handleRemoveFromInbox(ids);
  };

  const handleAddInboxToExisting = async (productId, images, ids) => {
    const target = draftProducts.find((p) => p.id === productId);
    if (!target) return;
    const updated = { ...target, photoPool: [...target.photoPool, ...images] };
    await handleSaveProduct(updated);
    handleRemoveFromInbox(ids);
  };

  const handleToggleOrderStatus = async (order) => {
    const updated = { ...order, status: order.status === "completado" ? "pendiente" : "completado" };
    await updateOrder(updated);
    setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
  };

  const handleUpdateTracking = async (order, trackingNumber) => {
    const updated = { ...order, trackingNumber };
    await updateOrder(updated);
    setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
  };

  // Pedir reseña a mano desde el panel, una vez que el pedido ya está
  // completado/entregado — manda el mail con el link y guarda cuándo se pidió
  // para que se vea en el panel (no bloquea poder pedirla de nuevo).
  const handleRequestReview = async (order) => {
    if (!order.customerEmail) return { ok: false, error: "Este pedido no tiene mail cargado." };
    const result = await sendEmail({
      to: order.customerEmail,
      subject: `¿Cómo te quedó tu pedido ${order.id}?`,
      html: buildReviewRequestEmailHtml(order, settings),
    });
    if (result.ok) {
      const updated = { ...order, reviewRequestedAt: Date.now() };
      await updateOrder(updated);
      setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
    }
    return result;
  };

  // Descuento manual sobre un pedido ya hecho (ej: compensar un problema).
  // Se guarda aparte del descuento de bienvenida y el total se recalcula acá,
  // nunca en el componente, para que quede consistente pase lo que pase.
  const handleApplyDiscount = async (order, { mode, amount, percent, reason }) => {
    const manualDiscountAmount = Math.max(0, Number(amount) || 0);
    const newTotal = Math.max(0, order.subtotal - (order.discountAmount || 0) - manualDiscountAmount) + (order.shippingCost || 0);
    const updated = {
      ...order,
      manualDiscountMode: mode,
      manualDiscountAmount,
      manualDiscountPercent: percent,
      manualDiscountReason: reason,
      total: newTotal,
    };
    await updateOrder(updated);
    setOrders((prev) => prev.map((o) => (o.id === order.id ? updated : o)));
  };

  const handleBulkComplete = async (ids) => {
    const targets = orders.filter((o) => ids.includes(o.id));
    const updates = await Promise.all(targets.map(async (o) => {
      const updated = { ...o, status: "completado" };
      await updateOrder(updated);
      return updated;
    }));
    setOrders((prev) => prev.map((o) => updates.find((u) => u.id === o.id) || o));
  };

  const handleBulkArchive = async (ids, archived) => {
    const targets = orders.filter((o) => ids.includes(o.id));
    const updates = await Promise.all(targets.map(async (o) => {
      const updated = { ...o, archived };
      await updateOrder(updated);
      return updated;
    }));
    setOrders((prev) => prev.map((o) => updates.find((u) => u.id === o.id) || o));
  };

  const handleBulkDelete = async (ids) => {
    await Promise.all(ids.map((id) => removeOrder(id)));
    setOrders((prev) => prev.filter((o) => !ids.includes(o.id)));
  };

  const handleSaveReview = async (review) => {
    await persistReview(review);
    setReviews((prev) => {
      const exists = prev.some((r) => r.id === review.id);
      return exists ? prev.map((r) => (r.id === review.id ? review : r)) : [...prev, review];
    });
  };

  const handleDeleteReview = async (id) => {
    await removeReview(id);
    setReviews((prev) => prev.filter((r) => r.id !== id));
  };

  const handleReorderReview = async (id, direction) => {
    setReviews((prev) => {
      const idx = prev.findIndex((r) => r.id === id);
      const swapWith = idx + direction;
      if (idx < 0 || swapWith < 0 || swapWith >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
      persistReviewOrder(next.map((r) => r.id));
      return next;
    });
  };

  const handleSaveSettings = async (partial) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      persistSettings(next);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="kulto-root min-h-screen" data-mode={themeMode}>
        <GlobalStyle colors={settings.theme} />
        <div className="h-16" style={{ borderBottom: "1px solid var(--line)" }} />
        <div className="max-w-6xl mx-auto px-4 md:px-6 py-14 md:py-24 grid md:grid-cols-2 gap-10">
          <div className="flex flex-col gap-4">
            <div className="kulto-skel rounded-xl h-12 w-3/4" />
            <div className="kulto-skel rounded-xl h-4 w-full" />
            <div className="kulto-skel rounded-xl h-4 w-2/3" />
            <div className="kulto-skel rounded-full h-12 w-40 mt-3" />
          </div>
          <div className="kulto-skel rounded-3xl h-64 md:h-96" />
        </div>
        <div className="max-w-6xl mx-auto px-4 md:px-6 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="kulto-skel rounded-2xl aspect-square" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="kulto-root min-h-screen flex flex-col" data-mode={themeMode}>
      <GlobalStyle colors={settings.theme} />
      <Header page={page} setPage={setPage} cartCount={cartCount} onOpenCart={() => setCartOpen(true)} logoImage={settings.logoImage} logoText={settings.logoText} customer={customer} themeMode={themeMode} onToggleThemeMode={toggleThemeMode} fontStep={fontStep} onDecreaseFont={decreaseFont} onIncreaseFont={increaseFont} socialLinks={{ instagram: settings.socialInstagram, facebook: settings.socialFacebook, tiktok: settings.socialTiktok }} showAdminMenu={hasAdminAccess} onGoAdminTab={jumpToAdminTab} onPreviewAsCustomer={() => { setPreviewAsCustomer(true); setPage("home"); }} productsMenuItems={settings.productsMenuItems || []} onGoCatalog={goToCatalog} />
      {hasAdminAccess && previewAsCustomer && (
        <div className="sticky top-16 z-30 flex items-center justify-center gap-3 px-4 py-2 text-sm font-semibold" style={{ background: "var(--sun)", color: "var(--ink)" }}>
          <span>Estás viendo la web como la vería un cliente.</span>
          <button
            onClick={() => { setPreviewAsCustomer(false); setPage("cuenta"); }}
            className="kulto-btn rounded-full px-3 py-1 text-xs"
            style={{ background: "var(--ink)", color: "var(--bone)" }}
          >
            Volver al panel
          </button>
        </div>
      )}
      <MarqueeStrip />
      {showAbandonedBanner && (
        <AbandonedCartBanner
          hours={Math.floor(hoursSince(cartSavedAt))}
          count={cartCount}
          onView={() => { setCartOpen(true); setShowAbandonedBanner(false); }}
          onDismiss={() => setShowAbandonedBanner(false)}
        />
      )}

      <main className={`flex-1 ${cart.length > 0 ? "pb-20 md:pb-0" : ""}`}>
        {page === "home" && (
          <Home
            products={sellableProducts}
            settings={settings}
            reviews={reviews}
            customWorkGallery={customWorkGallery}
            onOpen={setSelectedProduct}
            onGoCatalog={goToCatalog}
            onGoWizard={() => setPage("wizard")}
            onSearch={(q) => {
              setCatalogInitialGroup("");
              setCatalogSearchQuery(q);
              setPage("catalog");
            }}
            favorites={customer?.favorites}
            onToggleFavorite={handleToggleFavorite}
            onAddToCart={handleAddToCart}
          />
        )}
        {page === "catalog" && <Catalog products={sellableProducts} categories={categories} groups={groups} onOpen={setSelectedProduct} initialQuery={catalogSearchQuery} initialGroup={catalogInitialGroup} initialCategory={catalogInitialCategory} favorites={customer?.favorites} onToggleFavorite={handleToggleFavorite} onGoHome={() => setPage("home")} onAddToCart={handleAddToCart} />}
        {page === "favoritos" && <Catalog products={sellableProducts} categories={categories} groups={groups} onOpen={setSelectedProduct} favorites={customer?.favorites} onToggleFavorite={handleToggleFavorite} onlyFavorites onGoHome={() => setPage("home")} onAddToCart={handleAddToCart} />}
        {page === "wizard" && (
          <Wizard
            products={products}
            categories={categories}
            settings={settings}
            designLibrary={designLibrary}
            designFolders={designFolders}
            onAddToCart={handleAddToCart}
            onOpenProduct={setSelectedProduct}
            favorites={customer?.favorites}
            onToggleFavorite={handleToggleFavorite}
            onGoHome={() => setPage("home")}
          />
        )}
        {page === "seguimiento" && <OrderLookupPage initialOrderId={reviewDeepLinkOrderId} />}
        {page === "cuenta" && (
          effectiveAdminView ? (
            <AdminPanel
              permissions={adminPermissionsForAccount}
              isOwner={isAdminAccount}
              onSetAdminPermissions={handleSetAdminPermissions}
              products={draftProducts}
              categories={draftCategories}
              groups={draftGroups}
              orders={orders}
              customers={customersList}
              onAdjustCustomerPoints={handleAdjustCustomerPoints}
              onDeleteCustomer={handleDeleteCustomer}
              onCreateCustomer={handleAdminCreateCustomer}
              onUpdateCustomerInfo={handleAdminUpdateCustomerInfo}
              onSendPasswordHelp={handleRequestPasswordReset}
              reviews={reviews}
              settings={settings}
              hasDraftChanges={hasDraftChanges}
              publishing={publishing}
              onPublishChanges={handlePublishChanges}
              onDiscardChanges={handleDiscardChanges}
              photoInbox={photoInbox}
              onAddToInbox={handleAddToInbox}
              onCreateProductFromInbox={handleCreateProductFromInbox}
              onAddInboxToExisting={handleAddInboxToExisting}
              onRemoveFromInbox={handleRemoveFromInbox}
              savedColors={savedColors}
              onSaveColorToLibrary={handleSaveColorToLibrary}
              onRemoveColorFromLibrary={handleRemoveColorFromLibrary}
              designLibrary={designLibrary}
              onAddDesignToLibrary={handleAddDesignToLibrary}
              onRemoveDesignFromLibrary={handleRemoveDesignFromLibrary}
              designFolders={designFolders}
              onAddDesignFolder={handleAddDesignFolder}
              onRenameDesignFolder={handleRenameDesignFolder}
              onRemoveDesignFolder={handleRemoveDesignFolder}
              onToggleDesignFolderCover={handleToggleDesignFolderCover}
              onAssignDesignToFolder={handleAssignDesignToFolder}
              onSetDesignFolderCategory={handleSetDesignFolderCategory}
              customWorkGallery={customWorkGallery}
              onAddCustomWork={handleAddCustomWork}
              onRemoveCustomWork={handleRemoveCustomWork}
              onAddCategory={handleAddCategory}
              onRenameCategory={handleRenameCategory}
              onDeleteCategory={handleDeleteCategory}
              onAddGroup={handleAddGroup}
              onRenameGroup={handleRenameGroup}
              onDeleteGroup={handleDeleteGroup}
              onSaveProduct={handleSaveProduct}
              onDeleteProduct={handleDeleteProduct}
              onQuickRestock={handleQuickRestock}
              jumpTo={adminTabRequest}
              onToggleOrderStatus={handleToggleOrderStatus}
              onUpdateTracking={handleUpdateTracking}
              onApplyDiscount={handleApplyDiscount}
              onRequestReview={handleRequestReview}
              onBulkComplete={handleBulkComplete}
              onBulkArchive={handleBulkArchive}
              onBulkDelete={handleBulkDelete}
              onSaveReview={handleSaveReview}
              onDeleteReview={handleDeleteReview}
              onReorderReview={handleReorderReview}
              onSaveSettings={handleSaveSettings}
              onLogout={handleLogoutCustomer}
            />
          ) : (
            <AccountPage
              customer={customer}
              onRegister={handleRegisterCustomer}
              onLogin={handleLoginCustomer}
              onLogout={handleLogoutCustomer}
              onVerifyEmail={handleVerifyEmail}
              onResendVerification={handleResendVerification}
              onRequestPasswordReset={handleRequestPasswordReset}
              onResetPassword={handleResetPassword}
              settings={settings}
              initialResetEmail={resetDeepLinkEmail}
              initialResetCode={resetDeepLinkCode}
            />
          )
        )}

        {page === "home" && <FaqSection settings={settings} />}
        {!(page === "cuenta" && effectiveAdminView) && <ContactSection settings={settings} />}
      </main>

      <Footer settings={settings} />
      <WhatsAppFloat liftForMobileBar={cart.length > 0 && !cartOpen} />
      {cart.length > 0 && !cartOpen && (
        <MobileCartBar count={cartCount} total={cart.reduce((s, it) => s + it.qty * it.unitPrice, 0)} onOpen={() => setCartOpen(true)} />
      )}

      {selectedProduct && (
        <ProductModal
          product={selectedProduct}
          allProducts={sellableProducts}
          settings={settings}
          onClose={() => setSelectedProduct(null)}
          onSwitchProduct={setSelectedProduct}
          onAddToCart={handleAddToCart}
          favorites={customer?.favorites}
          onToggleFavorite={handleToggleFavorite}
          reviews={reviews}
          onGoHome={() => { setSelectedProduct(null); setPage("home"); }}
          onGoCatalog={() => { setSelectedProduct(null); setPage("catalog"); }}
          onView={handleTrackProductView}
        />
      )}

      {cartOpen && (
        <CartDrawer
          cart={cart}
          onClose={() => setCartOpen(false)}
          onUpdateQty={handleUpdateQty}
          onRemove={handleRemove}
          onCheckout={handleCheckout}
          customerName={customerName} setCustomerName={setCustomerName}
          customerPhone={customerPhone} setCustomerPhone={setCustomerPhone}
          customerEmail={customerEmail} setCustomerEmail={setCustomerEmail}
          comment={comment} setComment={setComment}
          deliveryMethod={deliveryMethod} setDeliveryMethod={setDeliveryMethod}
          address={address} setAddress={setAddress}
          settings={settings}
          sending={sending}
          customer={customer}
        />
      )}

      {confirmedOrderId && <OrderConfirm orderId={confirmedOrderId} hasCustom={confirmedHasCustom} onClose={() => setConfirmedOrderId(null)} />}
    </div>
  );
}
