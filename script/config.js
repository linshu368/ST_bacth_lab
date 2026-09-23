function readBooleanEnv(name, fallback) {
	const value = import.meta.env[name];
	if (value === undefined || value === '') return fallback;
	return value === 'true' || value === '1';
}

export const BATCH_LAB_CONFIG = [
	{
		BATCH_LAB_ALLOW_PRODUCTION_SOURCE: readBooleanEnv(
			'VITE_BATCH_LAB_ALLOW_PRODUCTION_SOURCE',
			true
		),
		BATCH_LAB_ENABLED: readBooleanEnv('VITE_BATCH_LAB_ENABLED', true),
		BATCH_LAB_MODEL_KEY: import.meta.env.VITE_BATCH_LAB_MODEL_KEY ?? '',
	},
];
