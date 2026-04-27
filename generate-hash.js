/**
 * generate-hash.js — Generador de hash para la contraseña del admin
 * ─────────────────────────────────────────────────────────────────
 * Uso (una sola vez, localmente):
 *   node generate-hash.js miContraseñaSegura
 *
 * El hash resultante va en la variable de entorno ADMIN_PASSWORD_HASH
 */

const bcrypt = require("bcrypt");

const password = process.argv[2];

if (!password) {
  console.error("❌ Uso: node generate-hash.js <contraseña>");
  process.exit(1);
}

if (password.length < 8) {
  console.error("❌ La contraseña debe tener al menos 8 caracteres.");
  process.exit(1);
}

bcrypt.hash(password, 12).then((hash) => {
  console.log("\n✅ Hash generado correctamente.\n");
  console.log("Agregá esta variable en Railway:\n");
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
  console.log("⚠️  Guardá la contraseña en un lugar seguro — el hash no es reversible.\n");
});
