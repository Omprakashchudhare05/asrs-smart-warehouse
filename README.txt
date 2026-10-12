AS/RS SMART WAREHOUSE - LIGHT THEME UPDATE

START
1. Extract this ZIP to a new folder.
2. Back up any newer asrs.db from your currently working project before replacing database files. The included DB is the copy originally uploaded in this conversation.
3. Run backend\start-backend.bat and keep its terminal open.
4. Open dashboard\index.html in Chrome or Edge.
5. First run: enter warehouse/store name, unique warehouse code and location, then create your own Boss/Admin User ID and password (minimum 8 characters). Warehouse details are saved once in SQLite.
6. Boss creates operator accounts in Operators. Login requires selecting the matching Boss/Admin or Operator role.

FEATURES
- Light theme with responsive layout and subtle UI animation.
- Login role selector and Show/Hide password controls.
- Dashboard shows total units currently in stock across all slots, lifetime units stored, lifetime units retrieved, occupied slots and free capacity.
- Operator menu includes Inventory Management, where operators can edit product name and SKU and perform Store/Retrieve operations.
- Boss menu does not include Inventory Management. Boss Settings manages slot capacity; Operators page manages operator accounts.
- Passwords stored as salted scrypt hashes; API requires a login token and capacity/operator-management endpoints are Boss-only.
- Existing slots and transaction rows are migrated additively. Do not delete the database.

NOTES
- This is a local-PC prototype. Sessions clear when backend restarts; sign in again.
- The included database is the uploaded database copy, not necessarily the latest database from another folder on your PC. Preserve your newest DB by backing it up and using it in backend\asrs.db after stopping the server.
- ESP32 is not required to test dashboard functions.
