import type { Express } from "express";
import type { Conversation, Task } from "@/lib/types";

export type VisitRouteDeps = Record<string, any>;

export function registerVisitRoutes(app: Express, deps: VisitRouteDeps) {
  const {
    requireAuth,
    requireRoles,
    isMySqlStateEnabled,
    ensureConversationsTable,
    migrateLegacyConversationsStateToMySql,
    resolveRequestCompanyId,
    normalizeWhitespace,
    firstString,
    isSalesRole,
    parseOptionalInteger,
    listConversationsFromMySql,
    getAuthUserByIdentifier,
    normalizeConversationPayload,
    getMySqlPool,
    upsertConversationInMySql,
    mapConversationRow,
    getConversationByIdFromMySql,
    ensureTaskVisitNotesColumns,
    mapVisitNoteRowToTask,
    parseOptionalQueryFloat,
    ensureVisitHistoryTable,
    mapVisitHistoryRow,
    normalizeVisitNoteTask,
    toMySqlDateTime,
    upsertVisitHistoryInMySql,
  } = deps;

  app.get("/api/conversations", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL conversations store is not configured." });
      return;
    }
    try {
      await ensureConversationsTable();
      await migrateLegacyConversationsStateToMySql();
      const companyId = await resolveRequestCompanyId(req);
      const requestedSalespersonId = normalizeWhitespace(firstString(req.query.salespersonId) || "");
      const salespersonId =
        isSalesRole((req as any).auth?.role)
          ? normalizeWhitespace((req as any).auth?.sub || "")
          : requestedSalespersonId || null;
      const limit =
        parseOptionalInteger(req.query.limit) ??
        250;
      const items = await listConversationsFromMySql({
        companyId,
        salespersonId,
        limit,
      });
      res.json({ items });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to fetch conversations from MySQL.";
      res.status(500).json({ message });
    }
  });

  app.post("/api/conversations", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL conversations store is not configured." });
      return;
    }
    const authRecord = (req as any).auth?.email ? getAuthUserByIdentifier((req as any).auth.email) : null;
    const body = req.body as { conversation?: Partial<Conversation> } | Partial<Conversation>;
    const payload =
      body && "conversation" in body && body.conversation && typeof body.conversation === "object"
        ? body.conversation
        : (body as Partial<Conversation>);
    let normalizedConversation = normalizeConversationPayload(payload || {}, authRecord?.user ?? null);
    if (!normalizedConversation.id) {
      res.status(400).json({ message: "Conversation id is required." });
      return;
    }
    if (isSalesRole((req as any).auth?.role) && (req as any).auth.sub) {
      normalizedConversation = {
        ...normalizedConversation,
        salespersonId: normalizeWhitespace((req as any).auth.sub || ""),
        salespersonName:
          normalizeWhitespace(authRecord?.user.name || "") ||
          normalizedConversation.salespersonName,
      };
    }
    if (!normalizedConversation.salespersonId) {
      res.status(400).json({ message: "Salesperson id is required." });
      return;
    }

    try {
      await ensureConversationsTable();
      await migrateLegacyConversationsStateToMySql();
      const companyId =
        normalizedConversation.companyId || (await resolveRequestCompanyId(req)) || null;
      const conn = await getMySqlPool();
      normalizedConversation = {
        ...normalizedConversation,
        companyId: companyId || undefined,
      };
      await upsertConversationInMySql(conn, normalizedConversation, companyId);
      res.status(201).json(mapConversationRow({
        id: normalizedConversation.id,
        company_id: companyId,
        salesperson_id: normalizedConversation.salespersonId,
        salesperson_name: normalizedConversation.salespersonName,
        customer_name: normalizedConversation.customerName,
        conversation_date: normalizedConversation.date,
        duration: normalizedConversation.duration,
        transcript: normalizedConversation.transcript ?? null,
        transcript_status: normalizedConversation.transcriptStatus,
        audio_uri: normalizedConversation.audioUri ?? null,
        transcription_error: normalizedConversation.transcriptionError ?? null,
        source: normalizedConversation.source ?? null,
        analysis_provider: normalizedConversation.analysisProvider ?? null,
        interest_score: normalizedConversation.interestScore,
        pitch_score: normalizedConversation.pitchScore,
        confidence_score: normalizedConversation.confidenceScore,
        talk_listen_ratio: normalizedConversation.talkListenRatio,
        sentiment: normalizedConversation.sentiment,
        buying_intent: normalizedConversation.buyingIntent,
        objections_json: JSON.stringify(normalizedConversation.objections || []),
        improvements_json: JSON.stringify(normalizedConversation.improvements || []),
        summary: normalizedConversation.summary ?? "",
        notes: normalizedConversation.notes ?? null,
        key_phrases_json: JSON.stringify(normalizedConversation.keyPhrases || []),
      }));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to store conversation in MySQL.";
      res.status(500).json({ message });
    }
  });

  app.patch("/api/conversations/:id", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL conversations store is not configured." });
      return;
    }
    const conversationId = normalizeWhitespace(firstString(req.params.id) || "");
    if (!conversationId) {
      res.status(400).json({ message: "Conversation id is required." });
      return;
    }
    const authRecord = (req as any).auth?.email ? getAuthUserByIdentifier((req as any).auth.email) : null;
    try {
      await ensureConversationsTable();
      await migrateLegacyConversationsStateToMySql();
      const companyId = await resolveRequestCompanyId(req);
      const salespersonId =
        isSalesRole((req as any).auth?.role) ? normalizeWhitespace((req as any).auth.sub || "") : null;
      const current = await getConversationByIdFromMySql(conversationId, {
        companyId,
        salespersonId,
      });
      if (!current) {
        res.status(404).json({ message: "Conversation not found." });
        return;
      }
      const body = req.body as { updates?: Partial<Conversation> } | Partial<Conversation>;
      const updates =
        body && "updates" in body && body.updates && typeof body.updates === "object"
          ? body.updates
          : (body as Partial<Conversation>);
      const merged = normalizeConversationPayload(
        {
          ...current,
          ...updates,
          id: current.id,
        },
        authRecord?.user ?? null,
        current
      );
      const conn = await getMySqlPool();
      await upsertConversationInMySql(conn, merged, companyId || current.companyId || null);
      res.json(merged);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to update conversation in MySQL.";
      res.status(500).json({ message });
    }
  });

  app.get("/api/visit-notes", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL visit notes store is not configured." });
      return;
    }

    try {
      await ensureTaskVisitNotesColumns();
      const companyId = await resolveRequestCompanyId(req);
      const conn = await getMySqlPool();
      const filters: string[] = [
        "task_type = 'field_visit'",
        "(TRIM(COALESCE(meeting_notes, '')) <> '' OR TRIM(COALESCE(visit_departure_notes, '')) <> '' OR departure_at IS NOT NULL)",
      ];
      const params: unknown[] = [];

      if (companyId) {
        filters.push("company_id = ?");
        params.push(companyId);
      }
      if (isSalesRole((req as any).auth?.role)) {
        filters.push("assigned_to_id = ?");
        params.push((req as any).auth.sub);
      }

      const [rows] = await conn.query(
        `SELECT
          id,
          company_id,
          title,
          description,
          task_type,
          assigned_to_id,
          assigned_to_name,
          assigned_by_id,
          status,
          priority,
          due_date,
          created_at,
          visit_plan_date,
          visit_sequence,
          visit_location_label,
          visit_location_address,
          visit_latitude,
          visit_longitude,
          arrival_at,
          departure_at,
          meeting_notes,
          meeting_notes_updated_at,
          visit_departure_notes,
          visit_departure_notes_updated_at,
          auto_capture_conversation_id
        FROM lff_tasks
        WHERE ${filters.join(" AND ")}
        ORDER BY COALESCE(visit_departure_notes_updated_at, meeting_notes_updated_at, departure_at, created_at) DESC`,
        params
      );

      res.json({ items: rows.map(mapVisitNoteRowToTask) });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to fetch visit notes from MySQL.";
      res.status(500).json({ message });
    }
  });

  app.get("/api/visit-history/nearby", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL visit history store is not configured." });
      return;
    }

    const latitude = parseOptionalQueryFloat(req.query.latitude);
    const longitude = parseOptionalQueryFloat(req.query.longitude);
    if (
      latitude === null ||
      longitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) {
      res.status(400).json({ message: "Valid latitude and longitude are required." });
      return;
    }

    const radiusMeters = Math.max(
      50,
      Math.min(5000, parseOptionalQueryFloat(req.query.radius_meters) ?? 250)
    );
    const limit = Math.max(1, Math.min(24, parseOptionalInteger(req.query.limit) ?? 8));
    const requestedSalespersonId = normalizeWhitespace(firstString(req.query.salesperson_id) || "");
    const salespersonId =
      isSalesRole((req as any).auth?.role)
        ? normalizeWhitespace((req as any).auth.sub || "")
        : requestedSalespersonId;

    try {
      await ensureVisitHistoryTable();
      const conn = await getMySqlPool();
      const companyId = await resolveRequestCompanyId(req);
      const latDelta = radiusMeters / 111_320;
      const lngDelta =
        radiusMeters /
        (111_320 * Math.max(0.1, Math.abs(Math.cos((latitude * Math.PI) / 180))));
      const filters = [
        "visit_latitude IS NOT NULL",
        "visit_longitude IS NOT NULL",
        "departure_at IS NOT NULL",
        "visit_latitude BETWEEN ? AND ?",
        "visit_longitude BETWEEN ? AND ?",
      ];
      const params: unknown[] = [
        latitude,
        longitude,
        latitude,
        latitude - latDelta,
        latitude + latDelta,
        longitude - lngDelta,
        longitude + lngDelta,
      ];

      if (companyId) {
        filters.push("company_id = ?");
        params.push(companyId);
      }
      if (salespersonId) {
        filters.push("salesperson_id = ?");
        params.push(salespersonId);
      }
      params.push(radiusMeters);

      const [rows] = await conn.query(
        `SELECT
          task_id,
          company_id,
          salesperson_id,
          salesperson_name,
          visit_label,
          visit_location_address,
          visit_latitude,
          visit_longitude,
          arrival_at,
          departure_at,
          meeting_notes,
          visit_departure_notes,
          auto_capture_conversation_id,
          status,
          source_updated_at,
          updated_at,
          ROUND(
            6371000 * ACOS(
              LEAST(
                1,
                GREATEST(
                  -1,
                  COS(RADIANS(?)) * COS(RADIANS(visit_latitude)) *
                  COS(RADIANS(visit_longitude) - RADIANS(?)) +
                  SIN(RADIANS(?)) * SIN(RADIANS(visit_latitude))
                )
              )
            )
          ) AS distance_meters
        FROM lff_visit_history
        WHERE ${filters.join(" AND ")}
        HAVING distance_meters <= ?
        ORDER BY distance_meters ASC, COALESCE(departure_at, updated_at) DESC
        LIMIT ${limit}`,
        params
      );

      res.json({ items: rows.map(mapVisitHistoryRow) });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to fetch nearby visit history.";
      res.status(500).json({ message });
    }
  });

  app.post("/api/visit-notes", requireAuth, async (req, res) => {
    if (!isMySqlStateEnabled()) {
      res.status(503).json({ message: "MySQL visit notes store is not configured." });
      return;
    }

    const body = req.body as { task?: Partial<Task> };
    const authRecord = (req as any).auth?.email ? getAuthUserByIdentifier((req as any).auth.email) : null;
    let normalizedTask = normalizeVisitNoteTask(body?.task || {}, authRecord?.user ?? null);

    if (!normalizedTask.id) {
      res.status(400).json({ message: "Task id is required." });
      return;
    }
    if (normalizedTask.taskType !== "field_visit") {
      res.status(400).json({ message: "Only field visit tasks can be synced as visit notes." });
      return;
    }
    if (isSalesRole((req as any).auth?.role) && (req as any).auth.sub) {
      normalizedTask = {
        ...normalizedTask,
        assignedTo: (req as any).auth.sub,
        assignedToName:
          normalizeWhitespace(authRecord?.user.name || "") ||
          normalizeWhitespace(normalizedTask.assignedToName || "") ||
          "Salesperson",
      };
    }

    try {
      await ensureTaskVisitNotesColumns();
      await ensureVisitHistoryTable();
      const companyId = normalizedTask.companyId || (await resolveRequestCompanyId(req)) || null;
      const conn = await getMySqlPool();
      const createdAtSql =
        toMySqlDateTime(normalizedTask.createdAt) ||
        new Date().toISOString().slice(0, 19).replace("T", " ");
      const updatedAtSql = new Date().toISOString().slice(0, 19).replace("T", " ");
      const assignedByName =
        normalizeWhitespace(authRecord?.user.name || "") ||
        normalizeWhitespace((req as any).auth?.email || "") ||
        "System";

      await conn.execute(
        `INSERT INTO lff_tasks (
          id,
          company_id,
          title,
          description,
          task_type,
          assigned_to_id,
          assigned_to_name,
          assigned_by_id,
          assigned_by_name,
          status,
          priority,
          due_date,
          created_at,
          updated_at,
          visit_plan_date,
          visit_sequence,
          visit_location_label,
          visit_location_address,
          visit_latitude,
          visit_longitude,
          arrival_at,
          departure_at,
          meeting_notes,
          meeting_notes_updated_at,
          visit_departure_notes,
          visit_departure_notes_updated_at,
          auto_capture_conversation_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          company_id = VALUES(company_id),
          title = VALUES(title),
          description = VALUES(description),
          task_type = VALUES(task_type),
          assigned_to_id = VALUES(assigned_to_id),
          assigned_to_name = VALUES(assigned_to_name),
          assigned_by_id = VALUES(assigned_by_id),
          assigned_by_name = VALUES(assigned_by_name),
          status = VALUES(status),
          priority = VALUES(priority),
          due_date = VALUES(due_date),
          visit_plan_date = VALUES(visit_plan_date),
          visit_sequence = VALUES(visit_sequence),
          visit_location_label = VALUES(visit_location_label),
          visit_location_address = VALUES(visit_location_address),
          visit_latitude = VALUES(visit_latitude),
          visit_longitude = VALUES(visit_longitude),
          arrival_at = VALUES(arrival_at),
          departure_at = VALUES(departure_at),
          meeting_notes = VALUES(meeting_notes),
          meeting_notes_updated_at = VALUES(meeting_notes_updated_at),
          visit_departure_notes = VALUES(visit_departure_notes),
          visit_departure_notes_updated_at = VALUES(visit_departure_notes_updated_at),
          auto_capture_conversation_id = VALUES(auto_capture_conversation_id),
          updated_at = NOW()`,
        [
          normalizedTask.id,
          companyId,
          normalizedTask.title,
          normalizedTask.description,
          normalizedTask.taskType,
          normalizedTask.assignedTo,
          normalizedTask.assignedToName,
          normalizedTask.assignedBy || (req as any).auth?.sub || "system",
          assignedByName,
          normalizedTask.status,
          normalizedTask.priority,
          toMySqlDateTime(normalizedTask.dueDate) || toMySqlDateTime(normalizedTask.createdAt),
          createdAtSql,
          updatedAtSql,
          toMySqlDateTime(normalizedTask.visitPlanDate),
          normalizedTask.visitSequence,
          normalizedTask.visitLocationLabel,
          normalizedTask.visitLocationAddress,
          normalizedTask.visitLatitude,
          normalizedTask.visitLongitude,
          toMySqlDateTime(normalizedTask.arrivalAt),
          toMySqlDateTime(normalizedTask.departureAt),
          normalizedTask.meetingNotes,
          toMySqlDateTime(normalizedTask.meetingNotesUpdatedAt),
          normalizedTask.visitDepartureNotes,
          toMySqlDateTime(normalizedTask.visitDepartureNotesUpdatedAt),
          normalizedTask.autoCaptureConversationId,
        ] as any[]
      );

      await upsertVisitHistoryInMySql(conn, normalizedTask, companyId);

      res.json({ ok: true });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unable to store visit notes in MySQL.";
      res.status(500).json({ message });
    }
  });

  app.delete(
    "/api/visit-notes/:taskId",
    requireAuth,
    requireRoles("admin", "hr", "manager"),
    async (req, res) => {
      if (!isMySqlStateEnabled()) {
        res.status(503).json({ message: "MySQL visit notes store is not configured." });
        return;
      }

      const taskId = normalizeWhitespace(firstString(req.params.taskId) || "");
      if (!taskId) {
        res.status(400).json({ message: "Task id is required." });
        return;
      }

      try {
        await ensureTaskVisitNotesColumns();
        await ensureVisitHistoryTable();
        const companyId = (await resolveRequestCompanyId(req)) || null;
        const conn = await getMySqlPool();

        const deleteParams = companyId ? [taskId, companyId] : [taskId];
        const deleteWhere = companyId ? "id = ? AND company_id = ?" : "id = ?";
        const deleteHistoryWhere = companyId ? "task_id = ? AND company_id = ?" : "task_id = ?";

        await conn.execute(
          `DELETE FROM lff_visit_history WHERE ${deleteHistoryWhere}`,
          deleteParams as any[]
        );

        const [result] = await conn.execute(
          `DELETE FROM lff_tasks WHERE ${deleteWhere} AND task_type = 'field_visit'`,
          deleteParams as any[]
        );

        if (!result?.affectedRows) {
          res.status(404).json({ message: "Field visit not found." });
          return;
        }

        res.json({ ok: true, taskId });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unable to delete field visit from MySQL.";
        res.status(500).json({ message });
      }
    }
  );


}
