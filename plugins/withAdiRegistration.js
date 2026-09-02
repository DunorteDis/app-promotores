const { withDangerousMod } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Prova de posse do pacote br.com.dunorte.vexo para a Verificação de
// desenvolvedor Android (Play Console). O snippet é vinculado à conta
// de desenvolvedor "Grupo Norte Distribuição".
const SNIPPET = 'CB75LEK5RWEB4AAAAAAAAAAAAA';

module.exports = (config) =>
  withDangerousMod(config, [
    'android',
    (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/main/assets');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'adi-registration.properties'), SNIPPET);
      return c;
    },
  ]);
