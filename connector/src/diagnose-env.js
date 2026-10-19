import { getConnectorEnvStatus } from './env-status.js';

console.log('Connector environment variable status:');
for (const [name, isSet] of Object.entries(getConnectorEnvStatus())) {
  console.log(`${name}: ${isSet ? 'set' : 'missing'}`);
}
