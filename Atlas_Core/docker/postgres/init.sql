-- ATLAS Core System Database Initialization
-- Bootstrap only: extensions, grants, and timezone. Schema authority is Go EnsureTables.

-- Create TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Create additional extensions that might be useful
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Set timezone
SET timezone = 'UTC';

-- Create basic database configuration
ALTER DATABASE atlas_core SET timezone TO 'UTC';

-- Grant necessary permissions to atlas user
GRANT ALL PRIVILEGES ON DATABASE atlas_core TO atlas;
GRANT ALL PRIVILEGES ON SCHEMA public TO atlas;

-- Log initialization completion
DO $$
BEGIN
    RAISE NOTICE 'ATLAS Core database initialized successfully with TimescaleDB extension';
END $$;
