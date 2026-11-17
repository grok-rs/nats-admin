## Label environments, protect production

Right-click a connection → **Set Environment…** to mark it `dev`, `test`, `staging` or `prod`. Names such as *prod-eu* or *staging* are recognised automatically.

On **production** connections:

- the tree label, status bar and dashboards turn red;
- deleting or purging anything requires typing the resource name;
- you're offered **read-only mode**, which blocks publishing, KV / stream / consumer / object changes, purges and acks, while browsing, subscriptions and requests keep working.
