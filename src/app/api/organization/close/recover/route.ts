
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const recoveryToken = process.env.CLOSURE_RECOVERY_TOKEN;
  const suppliedToken = request.headers.get("x-closure-recovery-token");

  if (!recoveryToken || !suppliedToken || suppliedToken !== recoveryToken) {
    return NextResponse.json({ error: "Yetkisiz erişim." }, { status: 401 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    return NextResponse.json({ error: "Sunucu ayarları eksik." }, { status: 500 });
  }

  const admin = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: jobs, error: jobsError } = await admin
    .from("organization_closure_jobs")
    .select("id, organization_id, requested_by, user_ids, deleted_user_ids, status")
    .in("status", ["pending", "processing", "failed"]);

  if (jobsError) {
    return NextResponse.json({ error: jobsError.message }, { status: 500 });
  }

  const results: Array<{ jobId: string; status: string; error?: string }> = [];

  for (const job of jobs || []) {
    const lockToken = crypto.randomUUID();

    const { data: lockAcquired, error: lockError } = await admin.rpc(
      "depomap_acquire_closure_lock",
      {
        p_job_id: job.id,
        p_lock_token: lockToken,
      },
    );

    if (lockError) {
      results.push({ jobId: job.id, status: "failed", error: lockError.message });
      continue;
    }

    if (!lockAcquired) {
      results.push({
        jobId: job.id,
        status: "skipped",
        error: "Başka bir işlem bu işletmeyi işliyor.",
      });
      continue;
    }

    try {
      const renewLock = async () => {
        const { data, error } = await admin.rpc(
          "depomap_renew_closure_lock",
          {
            p_job_id: job.id,
            p_lock_token: lockToken,
          },
        );

        if (error || !data) {
          throw new Error(
            error?.message || "İşlem kilidi yenilenemedi. Güvenlik için işlem durduruldu.",
          );
        }
      };

      const { data: freshJob, error: freshJobError } = await admin
        .from("organization_closure_jobs")
        .select("requested_by, user_ids, deleted_user_ids, status")
        .eq("id", job.id)
        .eq("lock_token", lockToken)
        .single();

      if (freshJobError || !freshJob) {
        throw new Error(freshJobError?.message || "İş kaydı okunamadı.");
      }

      if (freshJob.status === "completed") {
        results.push({ jobId: job.id, status: "completed" });
        continue;
      }

      const ownerId = freshJob.requested_by;

      const userIds = Array.from(new Set([
        ...((freshJob.user_ids || []) as string[]),
        ownerId,
      ]));

      const deleted = new Set<string>(
        (freshJob.deleted_user_ids || []) as string[],
      );

      const { data: org, error: orgError } = await admin
        .from("organizations")
        .select("id, owner_id, status")
        .eq("id", job.organization_id)
        .maybeSingle();

      if (orgError) throw new Error(orgError.message);

      if (org) {
        if (org.owner_id !== ownerId || org.status !== "closing") {
          throw new Error("İşletmenin kapatma durumu doğrulanamadı.");
        }

        await renewLock();

        const { error: deleteOrgError } = await admin
          .from("organizations")
          .delete()
          .eq("id", job.organization_id)
          .eq("owner_id", ownerId);

        if (deleteOrgError) throw new Error(deleteOrgError.message);
      }

      const workers = userIds.filter((id) => id !== ownerId);
      const failed: string[] = [];

      for (const userId of workers) {
        if (deleted.has(userId)) continue;

        await renewLock();

        const { error } = await admin.auth.admin.deleteUser(userId);

        if (error && !/not found|does not exist|user_not_found/i.test(error.message)) {
          failed.push(userId);
          continue;
        }

        deleted.add(userId);

        const { data: progressJob, error: progressError } = await admin
          .from("organization_closure_jobs")
          .update({
            deleted_user_ids: Array.from(deleted),
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lock_token", lockToken)
          .select("id")
          .maybeSingle();

        if (progressError || !progressJob) {
          throw new Error(progressError?.message || "İşlem kilidi kaybedildi.");
        }
      }

      if (failed.length > 0) {
        const { data: failedJob, error: statusError } = await admin
          .from("organization_closure_jobs")
          .update({
            status: "failed",
            failed_user_ids: [...failed, ownerId],
            error_message: `${failed.length} çalışan hesabı silinemedi.`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", job.id)
          .eq("lock_token", lockToken)
          .select("id")
          .maybeSingle();

        if (statusError || !failedJob) {
          throw new Error(statusError?.message || "İşlem kilidi kaybedildi.");
        }

        results.push({
          jobId: job.id,
          status: "failed",
          error: "Bazı çalışan hesapları silinemedi.",
        });

        continue;
      }

      if (!deleted.has(ownerId)) {
        await renewLock();

        const { error } = await admin.auth.admin.deleteUser(ownerId);

        if (error && !/not found|does not exist|user_not_found/i.test(error.message)) {
          const { data: failedJob, error: statusError } = await admin
            .from("organization_closure_jobs")
            .update({
              status: "failed",
              failed_user_ids: [ownerId],
              error_message: error.message,
              updated_at: new Date().toISOString(),
            })
            .eq("id", job.id)
            .eq("lock_token", lockToken)
            .select("id")
            .maybeSingle();

          if (statusError || !failedJob) {
            throw new Error(statusError?.message || "İşlem kilidi kaybedildi.");
          }

          results.push({
            jobId: job.id,
            status: "failed",
            error: "İşletme sahibi hesabı silinemedi.",
          });

          continue;
        }

        deleted.add(ownerId);
      }

      const { data: completedJob, error: completeError } = await admin
        .from("organization_closure_jobs")
        .update({
          deleted_user_ids: Array.from(deleted),
          failed_user_ids: [],
          status: "completed",
          error_message: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("lock_token", lockToken)
        .select("id")
        .maybeSingle();

      if (completeError || !completedJob) {
        throw new Error(completeError?.message || "İşlem kilidi kaybedildi.");
      }

      results.push({ jobId: job.id, status: "completed" });
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : "Bilinmeyen hata.";

      await admin
        .from("organization_closure_jobs")
        .update({
          status: "failed",
          error_message: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", job.id)
        .eq("lock_token", lockToken);

      results.push({ jobId: job.id, status: "failed", error: message });
    } finally {
      await admin.rpc("depomap_release_closure_lock", {
        p_job_id: job.id,
        p_lock_token: lockToken,
      });
    }
  }

  return NextResponse.json({
    success: results.every((result) => result.status === "completed"),
    processed: results.length,
    results,
  });
}
