import type { Express } from "express";

export type StockRouteDeps = Record<string, any>;

export function registerStockRoutes(app: Express, deps: StockRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    isMySqlStateEnabled,
    toNullableText,
    listStockistsFromMySql,
    ensureStockistAssignmentColumns,
    toStringId,
    toRequiredText,
    toSqlTimestamp,
    parseStringArrayJson,
    getMySqlPool,
    normalizeProductIds,
    resolveProductStockSchema,
    PRODUCT_STOCK_TABLE,
  } = deps;

  app.get(
    "/api/stockists",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL state store is not configured." });
        return;
      }
      const companyId = toNullableText(req.query.companyId);
      try {
        const items = await listStockistsFromMySql();
        const filtered = companyId
          ? items.filter(
              (entry: any) => entry && typeof entry === "object" && (entry as any).companyId === companyId
            )
          : items;
        res.json({ items: filtered });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to load channel partners.";
        res.status(500).json({ message });
      }
    }
  );

  app.post(
    "/api/stockists",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL state store is not configured." });
        return;
      }
      await ensureStockistAssignmentColumns();
      const body = (req.body || {}) as Record<string, unknown>;
      const id = toStringId(body.id);
      if (!id) {
        res.status(400).json({ message: "Stockist id is required." });
        return;
      }
      const companyId = toNullableText(body.companyId);
      const name = toRequiredText(body.name, "Channel Partner");
      const phone = toNullableText(body.phone);
      const location = toNullableText(body.location);
      const pincode = toNullableText(body.pincode);
      const notes = toNullableText(body.notes);
      const assignedSalespersonIdsProvided = Object.prototype.hasOwnProperty.call(
        body,
        "assignedSalespersonIds"
      );
      const createdAt = toSqlTimestamp(body.createdAt);
      const updatedAt = toSqlTimestamp(body.updatedAt ?? body.createdAt);

      try {
        const conn = await getMySqlPool();
        let assignedSalespersonIds = assignedSalespersonIdsProvided
          ? parseStringArrayJson(body.assignedSalespersonIds)
          : [];
        if (!assignedSalespersonIdsProvided) {
          const [existingRows] = await conn.query(
            `SELECT assigned_salesperson_ids_json FROM lff_stockists WHERE id = ? LIMIT 1`,
            [id]
          );
          if (existingRows && existingRows.length > 0) {
            assignedSalespersonIds = parseStringArrayJson(
              existingRows[0].assigned_salesperson_ids_json
            );
          }
        }
        await conn.execute(
          `INSERT INTO lff_stockists
            (id, company_id, name, phone, location, pincode, notes, assigned_salesperson_ids_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             name = VALUES(name),
             phone = VALUES(phone),
             location = VALUES(location),
             pincode = VALUES(pincode),
             notes = VALUES(notes),
             assigned_salesperson_ids_json = VALUES(assigned_salesperson_ids_json),
             updated_at = VALUES(updated_at)`,
          [
            id,
            companyId,
            name,
            phone,
            location,
            pincode,
            notes,
            JSON.stringify(assignedSalespersonIds),
            createdAt,
            updatedAt,
          ]
        );
        res.json({
          id,
          companyId: companyId || undefined,
          name,
          phone: phone || undefined,
          location: location || undefined,
          pincode: pincode || undefined,
          notes: notes || undefined,
          assignedSalespersonIds,
          createdAt: new Date(createdAt).toISOString(),
          updatedAt: new Date(updatedAt).toISOString(),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to save channel partner.";
        res.status(500).json({ message });
      }
    }
  );

  app.delete(
    "/api/stockists/:id",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL state store is not configured." });
        return;
      }
      const stockistId = toStringId(req.params.id);
      if (!stockistId) {
        res.status(400).json({ message: "Channel partner id is required." });
        return;
      }
      try {
        const conn = await getMySqlPool();
        const [result] = await conn.execute(
          "DELETE FROM lff_stockists WHERE id = ?",
          [stockistId]
        );
        if (!result?.affectedRows) {
          res.status(404).json({ message: "Channel partner not found." });
          return;
        }
        res.json({ id: stockistId });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to delete channel partner.";
        res.status(500).json({ message });
      }
    }
  );

  app.get(
    "/api/stock/products",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL stock store is not configured." });
        return;
      }
      const ids = normalizeProductIds(req.query.ids);
      if (!ids.length) {
        res.status(400).json({ message: "Product ids are required." });
        return;
      }
      try {
        const conn = await getMySqlPool();
        const schema = await resolveProductStockSchema(conn);
        const placeholders = ids.map(() => "?").join(", ");
        const query = `SELECT \`${schema.productIdCol}\` AS productId, SUM(COALESCE(\`${schema.qtyCol}\`, 0)) AS stock
          FROM \`${PRODUCT_STOCK_TABLE}\`
          WHERE \`${schema.productIdCol}\` IN (${placeholders})
          GROUP BY \`${schema.productIdCol}\``;
        const [rows] = await conn.execute(query, ids);
        const stockMap = new Map<string, number>();
        for (const row of rows || []) {
          const productId = String(row.productId ?? "");
          const stock = Number(row.stock);
          if (!productId) continue;
          stockMap.set(productId, Number.isFinite(stock) ? stock : 0);
        }
        const items = ids.map((id: any) => ({
          productId: String(id),
          stock: stockMap.get(String(id)) ?? 0,
        }));
        res.json({ items });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to read product stock.";
        res.status(500).json({ message });
      }
    }
  );

  app.post(
    "/api/stock/products/adjust",
    requireAuth,
    requireRoles("admin", "hr", "manager", "salesperson"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL stock store is not configured." });
        return;
      }
      const body = req.body as { productId?: unknown; delta?: unknown };
      const productId = Number(body.productId);
      const delta = Number(body.delta);
      if (!Number.isFinite(productId)) {
        res.status(400).json({ message: "Valid productId is required." });
        return;
      }
      if (!Number.isFinite(delta) || delta === 0) {
        res.status(400).json({ message: "Valid stock delta is required." });
        return;
      }
      try {
        const conn = await getMySqlPool();
        const schema = await resolveProductStockSchema(conn);
        const selectParts = [
          `\`${schema.qtyCol}\` AS stock`,
          schema.rowIdCol ? `\`${schema.rowIdCol}\` AS rowId` : "",
          schema.warehouseCol ? `\`${schema.warehouseCol}\` AS warehouseId` : "",
        ].filter(Boolean);
        const orderBy = schema.warehouseCol ? ` ORDER BY \`${schema.warehouseCol}\` ASC` : "";
        const selectQuery = `SELECT ${selectParts.join(", ")}
          FROM \`${PRODUCT_STOCK_TABLE}\`
          WHERE \`${schema.productIdCol}\` = ?
          ${orderBy}
          LIMIT 1`;
        const [rows] = await conn.execute(selectQuery, [productId]);
        if (!rows.length) {
          res.status(404).json({ message: "Product stock row not found." });
          return;
        }
        const current = Number(rows[0].stock);
        const nextStock = Math.max(0, (Number.isFinite(current) ? current : 0) + delta);

        if (schema.rowIdCol && rows[0].rowId !== undefined) {
          await conn.execute(
            `UPDATE \`${PRODUCT_STOCK_TABLE}\`
             SET \`${schema.qtyCol}\` = ?
             WHERE \`${schema.rowIdCol}\` = ?`,
            [nextStock, rows[0].rowId]
          );
        } else if (schema.warehouseCol && rows[0].warehouseId !== undefined) {
          await conn.execute(
            `UPDATE \`${PRODUCT_STOCK_TABLE}\`
             SET \`${schema.qtyCol}\` = ?
             WHERE \`${schema.productIdCol}\` = ? AND \`${schema.warehouseCol}\` = ?`,
            [nextStock, productId, rows[0].warehouseId]
          );
        } else {
          await conn.execute(
            `UPDATE \`${PRODUCT_STOCK_TABLE}\`
             SET \`${schema.qtyCol}\` = ?
             WHERE \`${schema.productIdCol}\` = ?`,
            [nextStock, productId]
          );
        }

        const [totalRows] = await conn.execute(
          `SELECT SUM(COALESCE(\`${schema.qtyCol}\`, 0)) AS stock
           FROM \`${PRODUCT_STOCK_TABLE}\`
           WHERE \`${schema.productIdCol}\` = ?`,
          [productId]
        );
        const total = Number(totalRows[0]?.stock);
        res.json({ productId: String(productId), stock: Number.isFinite(total) ? total : 0 });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to update product stock.";
        res.status(500).json({ message });
      }
    }
  );


}
