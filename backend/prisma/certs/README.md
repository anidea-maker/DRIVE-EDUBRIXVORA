# Certificates for the database connection (for example Aiven's `ca.pem`).
#
# Prisma resolves the `sslcert=` path relative to the `backend/prisma` folder, so
# a file stored at `backend/prisma/certs/aiven-ca.pem` is referenced as:
#
#   DATABASE_URL="mysql://user:pass@host:port/defaultdb?sslcert=certs/aiven-ca.pem&sslaccept=strict"
#
# Certificate files are git-ignored: they are per-environment, not code.
# Grab Aiven's from the service page -> "CA certificate".
