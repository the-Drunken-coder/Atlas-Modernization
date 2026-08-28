-- Bootstrap only. The Go migration system owns the Atlas schema.
SET timezone = 'UTC';
ALTER DATABASE atlas_core SET timezone TO 'UTC';
GRANT ALL PRIVILEGES ON DATABASE atlas_core TO atlas;
GRANT ALL PRIVILEGES ON SCHEMA public TO atlas;
