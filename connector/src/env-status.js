export const REQUIRED_CONNECTOR_ENV = Object.freeze([
  'ERP_API_URL',
  'CONNECTOR_TOKEN',
  'ZK_DEVICE_SERIAL',
]);

export function getConnectorEnvStatus(env = process.env) {
  return Object.fromEntries(REQUIRED_CONNECTOR_ENV.map((name) => [name, Boolean(env[name]?.trim())]));
}
