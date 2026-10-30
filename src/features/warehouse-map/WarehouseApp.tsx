"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { Stage, Layer, Rect, Text, Group, Line } from "react-konva";
import type { MapObject, MapObjectType, ProductEntry } from "@/types/warehouse";
import { OBJECT_COLORS } from "@/types/warehouse";

const SCALE = 42;
const initialObjects: MapObject[] = [
  { id: "pallet-1", type: "pallet", label: "Palet P-001", x: 1, y: 1, width: 1.2, length: 1.0, rotation: 0,
    products: [{ id: "prod-1", name: "Kakaolu kek", quantity: 12, unit: "adet" }, { id: "prod-2", name: "Kraker", quantity: null, unit: "adet" }] },
  { id: "rack-1", type: "rack", label: "Raf 1", x: 4, y: 1, width: 2.0, length: 1.0, rotation: 0, products: [] },
  { id: "cart-1", type: "cart", label: "Araba A-01", x: 1, y: 4, width: 0.8, length: 0.6, rotation: 0, products: [] }
];

function makeId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now() + Math.random());
}

const isCloudConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
);

type DbWarehouse = {
  id: string;
  name: string;
  width_m: number | string;
  length_m: number | string;
  grid_size_m: number | string;
};

type WarehousePatch = {
  name?: string;
  width_m?: number;
  length_m?: number;
  grid_size_m?: number;
};

export default function WarehouseApp() {
  const supabase = useMemo(() => (isCloudConfigured ? createClient() : null), []);
  const [user, setUser] = useState<{ id: string; email?: string; inviteCode?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(isCloudConfigured));
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCodeInput, setInviteCodeInput] = useState("");
  const [createdInviteCode, setCreatedInviteCode] = useState("");
  const [inviteCodeBusy, setInviteCodeBusy] = useState(false);
  const [inviteCodeMessage, setInviteCodeMessage] = useState("");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panGesture = useRef<{ kind: "mouse" | "touch" | null; lastX: number; lastY: number }>({ kind: null, lastX: 0, lastY: 0 });
  const [isSettingPassword, setIsSettingPassword] = useState(false);
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [membershipRole, setMembershipRole] = useState<string | null>(null);
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [storageUnitIds, setStorageUnitIds] = useState<Record<string, string>>({});
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);
  const [warehouseName, setWarehouseName] = useState("Ana Depo");
  const [widthM, setWidthM] = useState(12);
  const [lengthM, setLengthM] = useState(8);
  const [gridM, setGridM] = useState(0.5);
  const [objects, setObjects] = useState<MapObject[]>(isCloudConfigured ? [] : initialObjects);
  const [selectedId, setSelectedId] = useState<string | null>(isCloudConfigured ? null : "pallet-1");
  const [search, setSearch] = useState("");
  const [productName, setProductName] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unknownQuantity, setUnknownQuantity] = useState(false);
  const [notice, setNotice] = useState(isCloudConfigured ? "Hesap bağlantısı bekleniyor." : "Yerel demo modu: değişiklikler buluta kaydedilmiyor.");
  const [showAllProducts, setShowAllProducts] = useState(false);
  const canManageWarehouse = !isCloudConfigured || ["owner", "manager"].includes(membershipRole ?? "");
  const canEditOperations = !isCloudConfigured || ["owner", "manager", "worker"].includes(membershipRole ?? "");

// Oturum bilgisini al ve giriş/çıkış değişikliklerini dinle.
useEffect(() => {
  if (!supabase) return;

  let alive = true;

  supabase.auth.getSession().then(({ data, error }) => {
    if (!alive) return;

    if (error) setDataError(error.message);

    const session = data.session;

    if (session?.user) {
      setUser({
        id: session.user.id,
        email: session.user.email,
        inviteCode: typeof session.user.user_metadata?.depomap_invite_code === "string" ? session.user.user_metadata.depomap_invite_code : undefined,
      });

      if (
        session.user.invited_at &&
        !session.user.user_metadata?.password_set
      ) {
        setIsSettingPassword(true);
      }
    } else {
      setUser(null);
    }

    setAuthLoading(false);
  });

  const { data: authListener } = supabase.auth.onAuthStateChange(
    (event, session) => {
      if (!alive) return;

      setUser(
        session?.user
          ? {
              id: session.user.id,
              email: session.user.email,
              inviteCode: typeof session.user.user_metadata?.depomap_invite_code === "string" ? session.user.user_metadata.depomap_invite_code : undefined,
            }
          : null
      );

      if (event === "PASSWORD_RECOVERY") {
  setIsSettingPassword(true);
}

if (event === "USER_UPDATED" && session?.user.user_metadata?.password_set) {
  setIsSettingPassword(false);
}

      setAuthLoading(false);
    }
  );

  return () => {
    alive = false;
    authListener.subscription.unsubscribe();
  };
}, [supabase]);

  // Kullanıcının organizasyonunu, deposunu ve harita/ürün verilerini yükle.
  useEffect(() => {
    if (!supabase || !user) {
      setOrganizationId(null);
      setWarehouseId(null);
      setStorageUnitIds({});
      if (isCloudConfigured && !user) {
        setObjects([]);
        setSelectedId(null);
      }
      return;
    }

    let alive = true;
    let channel: any = null;

    async function loadWarehouseData(orgId: string, whId: string) {
      const [warehouseResult, objectsResult, unitsResult, contentsResult, productsResult] = await Promise.all([
        supabase!.from("warehouses").select("id,name,width_m,length_m,grid_size_m").eq("id", whId).eq("organization_id", orgId).single(),
        supabase!.from("map_objects").select("id,object_type,label,x_m,y_m,width_m,length_m,rotation_deg").eq("warehouse_id", whId).eq("organization_id", orgId),
        supabase!.from("storage_units").select("id,map_object_id,unit_type,label").eq("warehouse_id", whId).eq("organization_id", orgId),
        supabase!.from("storage_contents").select("storage_unit_id,product_id,quantity").eq("warehouse_id", whId).eq("organization_id", orgId),
        supabase!.from("products").select("id,name,unit_name").eq("organization_id", orgId)
      ]);

      const firstError = warehouseResult.error || objectsResult.error || unitsResult.error || contentsResult.error || productsResult.error;
      if (firstError) throw firstError;

      const warehouse = warehouseResult.data as DbWarehouse;
      const unitRows = unitsResult.data ?? [];
      const productRows = productsResult.data ?? [];
      const contentsByUnit = new Map<string, Array<{ id: string; name: string; quantity: number | null; unit: string }>>();
      const productById = new Map(productRows.map((p: any) => [p.id, p]));
      for (const content of contentsResult.data ?? []) {
        const product: any = productById.get(content.product_id);
        if (!product) continue;
        const current = contentsByUnit.get(content.storage_unit_id) ?? [];
        current.push({
          id: product.id,
          name: product.name,
          quantity: content.quantity === null ? null : Number(content.quantity),
          unit: product.unit_name || "adet"
        });
        contentsByUnit.set(content.storage_unit_id, current);
      }

      const unitIdByObject: Record<string, string> = {};
      for (const unit of unitRows as any[]) {
        if (unit.map_object_id) unitIdByObject[unit.map_object_id] = unit.id;
      }
      const unitIdByObjectReverse = new Map<string, string>(Object.entries(unitIdByObject));
      const loadedObjects: MapObject[] = (objectsResult.data ?? []).map((row: any) => {
        const unitId = unitIdByObjectReverse.get(row.id);
        return {
          id: row.id,
          type: row.object_type as MapObjectType,
          label: row.label,
          x: Number(row.x_m),
          y: Number(row.y_m),
          width: Number(row.width_m),
          length: Number(row.length_m),
          rotation: Number(row.rotation_deg),
          products: unitId ? (contentsByUnit.get(unitId) ?? []) : []
        };
      });

      if (!alive) return;
      setWarehouseName(warehouse.name);
      setWidthM(Number(warehouse.width_m));
      setLengthM(Number(warehouse.length_m));
      setGridM(Number(warehouse.grid_size_m));
      setStorageUnitIds(unitIdByObject);
      setObjects(loadedObjects);
      setSelectedId((current) => current && loadedObjects.some((o) => o.id === current) ? current : (loadedObjects[0]?.id ?? null));
      setDataError(null);
    }

    async function initialize() {
      setDataLoading(true);
      setDataError(null);
      try {
        // Davet kodu varsa önce kodu kullan; üyelik bundan sonra kalıcıdır.
        if (user!.inviteCode) {
          const { error: redeemError } = await supabase!.rpc("depomap_redeem_invite_code", {
            p_code: user!.inviteCode,
          });
          if (redeemError && !redeemError.message.toLocaleLowerCase("tr").includes("zaten üyesiniz")) {
            throw redeemError;
          }
          await supabase!.auth.updateUser({ data: { depomap_invite_code: null } });
        }

        const { data: membership, error: membershipError } = await supabase!
          .from("memberships")
          .select("organization_id,role")
          .eq("user_id", user!.id)
          .limit(1)
          .maybeSingle();
        if (membershipError) throw membershipError;
        setMembershipRole(membership?.role ?? "owner");

        let orgId = membership?.organization_id as string | undefined;
        let whId: string | undefined;

        if (!orgId) {
          const { data: created, error: createError } = await supabase!.rpc("depomap_create_organization", {
            p_organization_name: `${user!.email?.split("@")[0] || "Yeni"} organizasyonu`,
            p_warehouse_name: "Ana Depo",
            p_width_m: 12,
            p_length_m: 8,
            p_grid_size_m: 0.5
          });
          if (createError) throw createError;
          const createdRow: any = Array.isArray(created) ? created[0] : created;
          orgId = createdRow?.organization_id;
          whId = createdRow?.warehouse_id;
          if (!orgId || !whId) throw new Error("Organizasyon oluşturuldu ancak depo kimliği alınamadı.");
        }

        if (!whId) {
          const { data: existingWarehouse, error: warehouseError } = await supabase!
            .from("warehouses")
            .select("id")
            .eq("organization_id", orgId!)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
          if (warehouseError) throw warehouseError;
          whId = existingWarehouse?.id;
        }

        if (!whId) {
          const { data: newWarehouse, error: insertWarehouseError } = await supabase!
            .from("warehouses")
            .insert({ organization_id: orgId!, name: "Ana Depo", width_m: 12, length_m: 8, grid_size_m: 0.5 })
            .select("id")
            .single();
          if (insertWarehouseError) throw insertWarehouseError;
          whId = newWarehouse.id;
        }

        if (!alive) return;
        setOrganizationId(orgId!);
        setWarehouseId(whId!);
        await loadWarehouseData(orgId!, whId!);

        channel = supabase!.channel(`depomap-${orgId}-${whId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "map_objects", filter: `warehouse_id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "storage_units", filter: `warehouse_id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "storage_contents", filter: `warehouse_id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "products", filter: `organization_id=eq.${orgId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .on("postgres_changes", { event: "*", schema: "public", table: "warehouses", filter: `id=eq.${whId}` }, () => { void loadWarehouseData(orgId!, whId!); })
          .subscribe((status) => {
            if (alive && status === "SUBSCRIBED") setNotice("Bulut bağlantısı aktif. Değişiklikler kaydediliyor.");
          });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Bilinmeyen bağlantı hatası.";
        if (alive) {
          setDataError(message);
          setNotice(`Bulut verileri yüklenemedi: ${message}`);
        }
      } finally {
        if (alive) setDataLoading(false);
      }
    }

    void initialize();
    return () => {
      alive = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [supabase, user?.id]);

  async function handleAuthSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!supabase) return;

    setAuthBusy(true);
    setDataError(null);

    try {
      if (authMode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: {
            data: inviteCodeInput.trim()
              ? { depomap_invite_code: inviteCodeInput.trim().toUpperCase() }
              : {},
          },
        });

        if (error) throw error;

        if (!data.session) {
          setNotice(
            inviteCodeInput.trim()
              ? "Hesap oluşturuldu. E-posta doğrulamasından sonra davet kodun otomatik işlenecek."
              : "Hesap oluşturuldu. E-posta doğrulaması gerekiyorsa gelen kutunu kontrol et."
          );
        } else {
          setNotice(inviteCodeInput.trim() ? "Davet kodu kontrol ediliyor ve depoya katılım hazırlanıyor." : "Hesap oluşturuldu. Depo hazırlanıyor.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        });

        if (error) throw error;

        setNotice("Giriş başarılı. Depo verileri yükleniyor.");
      }

      setPassword("");
      if (authMode === "signup") setInviteCodeInput("");
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Kimlik doğrulama başarısız.";

      setDataError(message);
      setNotice(message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSetPassword(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();

  if (!supabase) return;

  setAuthBusy(true);
  setDataError(null);

  try {
    const { error } = await supabase.auth.updateUser({
  password,
  data: { password_set: true },
  });

    if (error) throw error;

    setPassword("");
    setIsSettingPassword(false);
    setNotice("Şifren başarıyla oluşturuldu. Depo yükleniyor.");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Şifre kaydedilemedi.";

    setDataError(message);
  } finally {
    setAuthBusy(false);
  }
}

  async function handleCreateInviteCode() {
    if (!supabase || !organizationId || !["owner", "manager"].includes(membershipRole ?? "")) {
      setInviteCodeMessage("Davet kodu oluşturma yetkin yok.");
      return;
    }
    setInviteCodeBusy(true);
    setInviteCodeMessage("");
    setCreatedInviteCode("");
    try {
      const { data, error } = await supabase.rpc("depomap_create_invite_code", {
        p_organization_id: organizationId,
        p_role: "worker",
      });
      if (error) throw error;
      setCreatedInviteCode(String(data));
      setInviteCodeMessage("Kod 7 gün boyunca yeni bir çalışanın katılımı için geçerlidir. Katılan çalışanın üyeliği kalıcıdır.");
    } catch (error) {
      setInviteCodeMessage(error instanceof Error ? error.message : "Davet kodu oluşturulamadı.");
    } finally {
      setInviteCodeBusy(false);
    }
  }

  async function copyInviteCode() {
    if (!createdInviteCode) return;
    try {
      await navigator.clipboard.writeText(createdInviteCode);
      setInviteCodeMessage("Davet kodu panoya kopyalandı.");
    } catch {
      setInviteCodeMessage("Kod kopyalanamadı. Kodu seçip elle kopyalayabilirsin.");
    }
  }

  async function signOut() {
  if (!supabase) return;

  const { error } = await supabase.auth.signOut();

  if (error) {
    setNotice(`Çıkış yapılamadı: ${error.message}`);
  }
  }
  const selected = objects.find((o) => o.id === selectedId) ?? null;
  const allProducts = useMemo(() => objects.flatMap((o) => o.products.map((p) => ({ ...p, objectId: o.id, objectLabel: o.label, objectType: o.type }))), [objects]);
  const results = search.trim()
    ? allProducts.filter((p) => p.name.toLocaleLowerCase("tr").includes(search.trim().toLocaleLowerCase("tr")))
    : [];

  function updateWarehouse(patch: WarehousePatch) {
    if (patch.name !== undefined) setWarehouseName(patch.name);
    if (patch.width_m !== undefined) setWidthM(patch.width_m);
    if (patch.length_m !== undefined) setLengthM(patch.length_m);
    if (patch.grid_size_m !== undefined) setGridM(patch.grid_size_m);
    if (!supabase || !warehouseId || !organizationId) return;
    void supabase.from("warehouses").update(patch).eq("id", warehouseId).eq("organization_id", organizationId)
      .then(({ error }) => { if (error) setNotice(`Depo ayarı kaydedilemedi: ${error.message}`); });
  }

  function updateObject(id: string, patch: Partial<MapObject>) {
    setObjects((prev) => prev.map((o) => o.id === id ? { ...o, ...patch } : o));
    if (!supabase || !organizationId || !warehouseId) return;
    const dbPatch: Record<string, string | number> = {};
    if (patch.label !== undefined) dbPatch.label = patch.label;
    if (patch.x !== undefined) dbPatch.x_m = patch.x;
    if (patch.y !== undefined) dbPatch.y_m = patch.y;
    if (patch.width !== undefined) dbPatch.width_m = patch.width;
    if (patch.length !== undefined) dbPatch.length_m = patch.length;
    if (patch.rotation !== undefined) dbPatch.rotation_deg = patch.rotation;
    if (Object.keys(dbPatch).length === 0) return;
    void supabase.from("map_objects").update(dbPatch).eq("id", id).eq("warehouse_id", warehouseId).eq("organization_id", organizationId)
      .then(({ error }) => { if (error) setNotice(`Nesne kaydedilemedi: ${error.message}`); });
    if (patch.label !== undefined && storageUnitIds[id]) {
      void supabase.from("storage_units").update({ label: patch.label }).eq("id", storageUnitIds[id]).eq("organization_id", organizationId)
        .then(({ error }) => { if (error) setNotice(`Konum etiketi kaydedilemedi: ${error.message}`); });
    }
  }

  async function addObject(type: MapObjectType) {
    const count = objects.filter((o) => o.type === type).length + 1;
    const labels: Record<MapObjectType, string> = { pallet: `Palet P-${String(count).padStart(3, "0")}`, rack: `Raf ${count}`, cart: `Araba A-${String(count).padStart(2, "0")}`, wall: `Duvar ${count}`, aisle: `Koridor ${count}` };
    const object: MapObject = {
      id: makeId(), type, label: labels[type], x: 1 + (count % 4) * 1.5, y: 1 + (count % 3) * 1.5,
      width: type === "rack" ? 2 : type === "wall" ? 3 : type === "aisle" ? 2 : 1,
      length: type === "rack" ? 1 : type === "wall" ? 0.1 : type === "aisle" ? 1 : 0.8,
      rotation: 0, products: []
    };

    if (supabase && organizationId && warehouseId) {
      const { error: objectError } = await supabase.from("map_objects").insert({
        id: object.id, organization_id: organizationId, warehouse_id: warehouseId, object_type: type,
        label: object.label, x_m: object.x, y_m: object.y, width_m: object.width, length_m: object.length, rotation_deg: 0
      });
      if (objectError) { setNotice(`Nesne eklenemedi: ${objectError.message}`); return; }

      if (["pallet", "rack", "cart"].includes(type)) {
        const unitType = type as "pallet" | "rack" | "cart";
        const { data: unit, error: unitError } = await supabase.from("storage_units").insert({
          id: makeId(), organization_id: organizationId, warehouse_id: warehouseId, map_object_id: object.id,
          unit_type: unitType, label: object.label
        }).select("id").single();
        if (unitError) {
          await supabase.from("map_objects").delete().eq("id", object.id).eq("organization_id", organizationId);
          setNotice(`Depolama konumu oluşturulamadı: ${unitError.message}`);
          return;
        }
        setStorageUnitIds((prev) => ({ ...prev, [object.id]: unit.id }));
      }
    }
    setObjects((prev) => [...prev, object]);
    setSelectedId(object.id);
    setNotice(`${object.label} eklendi${supabase ? " ve buluta kaydedildi." : " (yerel demo)."}`);
  }

  async function removeObject(id: string) {
    const target = objects.find((o) => o.id === id);
    if (!target) return;
    const confirmed = window.confirm(`${target.label} kaldırılsın mı? Bu konumdaki ürün yerleşimleri de kaldırılacak.`);
    if (!confirmed) return;
    if (supabase && organizationId && warehouseId) {
      const { error } = await supabase.from("map_objects").delete().eq("id", id).eq("warehouse_id", warehouseId).eq("organization_id", organizationId);
      if (error) { setNotice(`Nesne silinemedi: ${error.message}`); return; }
    }
    setObjects((prev) => prev.filter((o) => o.id !== id));
    setStorageUnitIds((prev) => { const next = { ...prev }; delete next[id]; return next; });
    setSelectedId((current) => current === id ? null : current);
    setNotice(`${target.label} kaldırıldı.`);
  }

  async function addProduct() {
    if (!selected || !["pallet", "rack", "cart"].includes(selected.type)) {
      setNotice("Önce palet, raf veya araba seç.");
      return;
    }
    if (!productName.trim()) {
      setNotice("Ürün adı gerekli.");
      return;
    }
    const q = unknownQuantity || quantity.trim() === "" ? null : Number(quantity);
    if (q !== null && (!Number.isFinite(q) || q < 0)) {
      setNotice("Miktar sıfır veya daha büyük olmalı.");
      return;
    }

    if (supabase && organizationId && warehouseId) {
      let unitId = storageUnitIds[selected.id];
      if (!unitId) {
        const { data: unit, error: unitError } = await supabase.from("storage_units").select("id").eq("map_object_id", selected.id).eq("organization_id", organizationId).maybeSingle();
        if (unitError || !unit) { setNotice(`Bu nesne için depolama konumu bulunamadı${unitError ? `: ${unitError.message}` : "."}`); return; }
        unitId = unit.id;
        setStorageUnitIds((prev) => ({ ...prev, [selected.id]: unitId! }));
      }

      let productId: string;
      const { data: existingProducts, error: findProductError } = await supabase.from("products").select("id,name,unit_name").eq("organization_id", organizationId).eq("name", productName.trim()).limit(1);
      if (findProductError) { setNotice(`Ürün aranamadı: ${findProductError.message}`); return; }
      if (existingProducts?.length) {
        productId = existingProducts[0].id;
      } else {
        const { data: newProduct, error: productError } = await supabase.from("products").insert({
          id: makeId(), organization_id: organizationId, name: productName.trim(), unit_name: "adet"
        }).select("id").single();
        if (productError) { setNotice(`Ürün oluşturulamadı: ${productError.message}`); return; }
        productId = newProduct.id;
      }

      const { data: existingContent, error: contentLookupError } = await supabase.from("storage_contents").select("quantity").eq("storage_unit_id", unitId).eq("product_id", productId).maybeSingle();
      if (contentLookupError) { setNotice(`Ürün konumu kontrol edilemedi: ${contentLookupError.message}`); return; }
      const finalQuantity = existingContent
        ? (existingContent.quantity === null || q === null ? null : Number(existingContent.quantity) + q)
        : q;
      const contentWrite = existingContent
        ? await supabase.from("storage_contents").update({ quantity: finalQuantity, updated_by: user?.id, updated_at: new Date().toISOString() }).eq("storage_unit_id", unitId).eq("product_id", productId)
        : await supabase.from("storage_contents").insert({ id: makeId(), organization_id: organizationId, warehouse_id: warehouseId, storage_unit_id: unitId, product_id: productId, quantity: finalQuantity, updated_by: user?.id });
      if (contentWrite.error) { setNotice(`Ürün depoya kaydedilemedi: ${contentWrite.error.message}`); return; }
      const { data: savedProduct } = await supabase.from("products").select("id,name,unit_name").eq("id", productId).single();
      setObjects((prev) => prev.map((o) => {
        if (o.id !== selected.id) return o;
        const exists = o.products.some((p) => p.id === productId);
        const nextProduct: ProductEntry = { id: productId, name: savedProduct?.name || productName.trim(), quantity: finalQuantity, unit: savedProduct?.unit_name || "adet" };
        return { ...o, products: exists ? o.products.map((p) => p.id === productId ? nextProduct : p) : [...o.products, nextProduct] };
      }));
      setProductName(""); setQuantity(""); setUnknownQuantity(false);
      setNotice(`${productName.trim()}, ${selected.label} konumuna kaydedildi.`);
      return;
    }

    const product: ProductEntry = { id: makeId(), name: productName.trim(), quantity: q, unit: "adet" };
    setObjects((prev) => prev.map((o) => o.id === selected.id ? { ...o, products: [...o.products, product] } : o));
    setProductName(""); setQuantity(""); setUnknownQuantity(false);
    setNotice(`${product.name}, ${selected.label} konumuna eklendi (yerel demo).`);
  }

  async function removeProduct(productId: string) {
    if (!selected) return;
    if (supabase && organizationId) {
      const unitId = storageUnitIds[selected.id];
      if (!unitId) { setNotice("Bu ürün için depolama konumu bulunamadı."); return; }
      const { error } = await supabase.from("storage_contents").delete().eq("storage_unit_id", unitId).eq("product_id", productId).eq("organization_id", organizationId);
      if (error) { setNotice(`Ürün konumdan çıkarılamadı: ${error.message}`); return; }
    }
    setObjects((prev) => prev.map((o) => o.id === selected.id ? { ...o, products: o.products.filter((p) => p.id !== productId) } : o));
    setNotice("Ürün bu konumdan çıkarıldı.");
  }

  function moveObject(id: string, x: number, y: number, free: boolean) {
    const obj = objects.find((o) => o.id === id);
    if (!obj) return;
    const snap = (v: number) => Math.round(v / gridM) * gridM;
    const nextX = free ? x : snap(x);
    const nextY = free ? y : snap(y);
    updateObject(id, {
      x: Math.max(0, Math.min(widthM - obj.width, nextX)),
      y: Math.max(0, Math.min(lengthM - obj.length, nextY))
    });
  }

  function startMapMousePan(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 1) return;
    e.preventDefault();
    panGesture.current = { kind: "mouse", lastX: e.clientX, lastY: e.clientY };
  }

  function moveMapMousePan(e: React.MouseEvent<HTMLDivElement>) {
    if (panGesture.current.kind !== "mouse") return;
    setPan((current) => ({ x: current.x + e.clientX - panGesture.current.lastX, y: current.y + e.clientY - panGesture.current.lastY }));
    panGesture.current.lastX = e.clientX;
    panGesture.current.lastY = e.clientY;
  }

  function endMapPan() { panGesture.current.kind = null; }

  function touchCenter(touches: React.TouchList) {
    return { x: (touches[0].clientX + touches[1].clientX) / 2, y: (touches[0].clientY + touches[1].clientY) / 2 };
  }

  function startMapTouchPan(e: React.TouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 2) return;
    const center = touchCenter(e.touches);
    panGesture.current = { kind: "touch", lastX: center.x, lastY: center.y };
  }

  function moveMapTouchPan(e: React.TouchEvent<HTMLDivElement>) {
    if (e.touches.length !== 2 || panGesture.current.kind !== "touch") return;
    e.preventDefault();
    const center = touchCenter(e.touches);
    setPan((current) => ({ x: current.x + center.x - panGesture.current.lastX, y: current.y + center.y - panGesture.current.lastY }));
    panGesture.current.lastX = center.x;
    panGesture.current.lastY = center.y;
  }

  const canvasWidth = Math.max(300, widthM * SCALE);
  const canvasHeight = Math.max(240, lengthM * SCALE);

  if (isCloudConfigured && authLoading) {
    return <main className="app-shell"><section className="panel" style={{ maxWidth: 520, margin: "12vh auto", padding: 32 }}><h1>deStock</h1><p>Oturum kontrol ediliyor...</p></section></main>;
  }

  if (isCloudConfigured && !user) {
    return (
      <main className="app-shell">
        <section className="panel" style={{ maxWidth: 480, margin: "8vh auto", padding: 32 }}>
          <div className="brand-mark" style={{ marginBottom: 16 }}>D</div>
          <p className="eyebrow">DESTOCK / BULUT HESABI</p>
          <h1 style={{ marginBottom: 8 }}>{authMode === "signin" ? "Hesabına giriş yap" : "Yeni hesap oluştur"}</h1>
          <p className="subtitle">Depo bilgilerin hesabına kaydedilir ve yetkili ekip üyeleriyle senkronize edilir.</p>
          <form onSubmit={handleAuthSubmit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
            <label className="field-label">E-posta<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field-label">Şifre<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {authMode === "signup" && <label className="field-label">Davet kodu <span style={{ color: "#999", fontWeight: 400 }}>(çalışan hesabı için)</span><input autoCapitalize="characters" placeholder="DSK-XXXXXXXXXXXX" value={inviteCodeInput} onChange={(e) => setInviteCodeInput(e.target.value.toUpperCase())} /></label>}
            <button className="primary-button full-button" type="submit" disabled={authBusy}>{authBusy ? "İşleniyor..." : authMode === "signin" ? "Giriş yap" : "Hesap oluştur"}</button>
          </form>
          <button type="button" className="secondary-button full-button" style={{ marginTop: 12 }} onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setDataError(null); }}>
            {authMode === "signin" ? "Yeni hesap oluştur" : "Zaten hesabım var · Giriş yap"}
          </button>
          {dataError && <p role="alert" style={{ color: "#b42318", marginTop: 16 }}>{dataError}</p>}
          {notice && !dataError && <p className="helper-text" style={{ marginTop: 16 }}>{notice}</p>}
          <p className="helper-text" style={{ marginTop: 18 }}>Hesap oluştururken e-posta doğrulaması istenebilir. Bu ayar Supabase Authentication bölümünden yönetilir.</p>
        </section>
      </main>
    );
  }

  if (isCloudConfigured && user && isSettingPassword) {
  return (
    <main className="app-shell">
      <section
        className="panel"
        style={{ maxWidth: 480, margin: "8vh auto", padding: 32 }}
      >
        <div className="brand-mark" style={{ marginBottom: 16 }}>D</div>
        <p className="eyebrow">DESTOCK / DAVET</p>
        <h1>Şifreni belirle</h1>
        <p className="subtitle">
          Ekibine katılmak için hesabının şifresini oluştur.
        </p>

        <form
          onSubmit={handleSetPassword}
          style={{ display: "grid", gap: 14, marginTop: 24 }}
        >
          <label className="field-label">
            Yeni şifre
            <input
              type="password"
              autoComplete="new-password"
              minLength={6}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          <button
            className="primary-button full-button"
            type="submit"
            disabled={authBusy}
          >
            {authBusy ? "Kaydediliyor..." : "Şifremi oluştur"}
          </button>
        </form>

        {dataError && (
          <p role="alert" style={{ color: "#b42318", marginTop: 16 }}>
            {dataError}
          </p>
        )}
      </section>
    </main>
  );
}

  return (
    <main className="app-shell">
      <style jsx global>{`
        .app-shell { min-height: 100vh; background: #090a0d !important; color: #f2f3f5 !important; }
        .app-shell .panel, .app-shell .map-panel, .app-shell .search-panel { background: #14161b !important; color: #f2f3f5 !important; border: 1px solid #292d36 !important; box-shadow: 0 12px 36px rgba(0,0,0,.22); }
        .app-shell .topbar { background: #0d0f13 !important; border-bottom: 1px solid #292d36 !important; }
        .app-shell .brand-mark { background: linear-gradient(145deg,#ff555d,#a90f1c) !important; color: white !important; box-shadow: 0 0 22px rgba(220,35,48,.22); }
        .app-shell .brand-copy strong, .app-shell h1, .app-shell h2, .app-shell h3 { color: #f7f7f8 !important; }
        .app-shell .subtitle, .app-shell .helper-text, .app-shell .panel-kicker, .app-shell .field-label { color: #aeb3bd !important; }
        .app-shell input, .app-shell select { background: #0d0f13 !important; color: #f5f5f6 !important; border: 1px solid #363b46 !important; }
        .app-shell .primary-button { background: linear-gradient(135deg,#f0444e,#b81727) !important; border: 1px solid #f0444e !important; color: white !important; }
        .app-shell .secondary-button, .app-shell .add-button { background: #1b1e25 !important; color: #f0f1f3 !important; border: 1px solid #383d48 !important; }
        .app-shell .map-viewport { background: #0b0d11 !important; border: 1px solid #333844 !important; overflow: hidden !important; user-select: none; }
        .app-shell .map-scroll { will-change: transform; }
        .app-shell .metric-card, .app-shell .selected-object, .app-shell .product-row, .app-shell .search-result, .app-shell .invite-code-card { background: #1b1e25 !important; border-color: #343944 !important; color: #f2f3f5 !important; }
        .app-shell .invite-code-card { display: grid; gap: 10px; padding: 14px; margin-top: 12px; border: 1px solid #71313a !important; border-radius: 12px; }
        .app-shell .invite-code-card strong { color: #ff5a64; font: 700 20px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 1px; overflow-wrap: anywhere; }
        .app-shell .footer { color: #858b98 !important; border-top: 1px solid #292d36 !important; }
        .app-shell .map-legend, .app-shell .map-footer { color: #b9bec8 !important; }
        @media (max-width: 760px) { .app-shell .map-viewport { max-height: 58vh; } .app-shell .topbar { flex-wrap: wrap; gap: 8px; } .app-shell .map-header { gap: 10px; flex-wrap: wrap; } }
      `}</style>
      <header className="topbar">
        <div className="brand-mark">D</div>
        <div className="brand-copy"><strong>deStock</strong><span>Depo konum yönetimi</span></div>
        <div className="topbar-spacer" />
        <button
          type="button"
          className="secondary-button"
          onClick={() => setShowAllProducts(true)}
          style={{ marginRight: 12, whiteSpace: "nowrap" }}
        >
          Ürün listesi ({allProducts.length})
        </button>
        {isCloudConfigured ? <><span className={`status-pill ${dataError ? "status-warn" : ""}`}>{dataError ? "Bulut hatası" : "Bulut bağlantısı"}</span><button type="button" className="secondary-button" onClick={signOut}>Çıkış yap</button></> : <span className="status-pill status-warn">Yerel demo · bulut ayarı yok</span>}
      </header>

      <section className="welcome-row">
        <div>
          <p className="eyebrow">DEPO YÖNETİMİ / HARİTA EDİTÖRÜ</p>
          <h1>Depodaki her şeyin yerini bil.</h1>
          <p className="subtitle">Ölçülü harita üzerinde palet, raf ve arabaları yerleştir. Ürün konumlarını tek ekrandan yönet.</p>
        </div>
        <div className="demo-notice"><span className="notice-dot" /> {notice}</div>
      </section>

      {dataError && <div role="alert" className="demo-notice" style={{ marginBottom: 16, color: "#b42318" }}>Bulut bağlantısı: {dataError}. SQL erişim kurulumunu kontrol et.</div>}
      <section className="workspace">
        <aside className="panel settings-panel">
          <div className="panel-heading"><div><span className="panel-kicker">01 / PLAN</span><h2>Depo ayarları</h2></div></div>
          {canManageWarehouse ? (
            <>
              <label className="field-label">Depo adı<input value={warehouseName} onChange={(e) => updateWarehouse({ name: e.target.value })} /></label>
              <div className="field-grid">
                <label className="field-label">Genişlik (m)<input type="number" min="1" max="100" value={widthM} onChange={(e) => updateWarehouse({ width_m: Math.max(1, Number(e.target.value) || 1) })} /></label>
                <label className="field-label">Uzunluk (m)<input type="number" min="1" max="100" value={lengthM} onChange={(e) => updateWarehouse({ length_m: Math.max(1, Number(e.target.value) || 1) })} /></label>
              </div>
              <label className="field-label">Izgara aralığı
                <select value={gridM} onChange={(e) => updateWarehouse({ grid_size_m: Number(e.target.value) })}>
                  <option value={0.25}>25 cm</option><option value={0.5}>50 cm</option><option value={1}>1 metre</option>
                </select>
              </label>
            </>
          ) : <p className="helper-text">Depo ayarlarını yalnızca depo sahibi veya yönetici değiştirebilir.</p>}
          <div className="metric-grid">
            <div className="metric-card"><span>Alan</span><strong>{(widthM * lengthM).toLocaleString("tr-TR")} m²</strong></div>
            <div className="metric-card"><span>Nesne</span><strong>{objects.length}</strong></div>
          </div>
          {isCloudConfigured && organizationId && ["owner", "manager"].includes(membershipRole ?? "") && (
            <>
              <div className="section-rule" />
              <div className="panel-heading compact">
                <div><span className="panel-kicker">EKİP YÖNETİMİ</span><h2>Çalışan daveti</h2></div>
              </div>
              <p className="helper-text">Tek kullanımlık kod oluştur. Çalışan hesap açarken kodu girerek bu depoya katılır.</p>
              <button type="button" className="primary-button full-button" onClick={handleCreateInviteCode} disabled={inviteCodeBusy}>
                {inviteCodeBusy ? "Kod oluşturuluyor..." : "＋ Davet kodu oluştur"}
              </button>
              {createdInviteCode && (
                <div className="invite-code-card">
                  <span className="panel-kicker">7 GÜN GEÇERLİ · TEK KULLANIM</span>
                  <strong>{createdInviteCode}</strong>
                  <button type="button" className="secondary-button full-button" onClick={copyInviteCode}>Kodu kopyala</button>
                </div>
              )}
              {inviteCodeMessage && <p className="helper-text" role="status">{inviteCodeMessage}</p>}
            </>
          )}
          {canEditOperations && <>
            <div className="section-rule" />
            <div className="panel-heading compact"><div><span className="panel-kicker">02 / EKLE</span><h2>Haritaya nesne</h2></div></div>
            <div className="add-grid">
              <button onClick={() => addObject("pallet")} className="add-button"><span className="object-icon pallet-icon">▦</span><span>Palet</span><b>+</b></button>
              <button onClick={() => addObject("rack")} className="add-button"><span className="object-icon rack-icon">▤</span><span>Raf</span><b>+</b></button>
              <button onClick={() => addObject("cart")} className="add-button"><span className="object-icon cart-icon">▱</span><span>Araba</span><b>+</b></button>
            </div>
            <p className="helper-text">Nesneleri harita üzerinde sürükle. Alt tuşunu basılı tutarak ızgara dışında konumlandırabilirsin.</p>
          </>}
          {!canEditOperations && <p className="helper-text">Görüntüleyici hesabı: harita salt okunur.</p>}
        </aside>

        <section className="map-panel">
          <div className="map-header">
            <div><span className="panel-kicker">CANLI ÖNİZLEME</span><h2>{warehouseName || "Yeni depo"}</h2><p>{widthM} m × {lengthM} m · {gridM} m ızgara</p></div>
            <div className="map-legend"><span><i className="legend-dot pallet-dot" />Palet</span><span><i className="legend-dot rack-dot" />Raf</span><span><i className="legend-dot cart-dot" />Araba</span></div>
          </div>
          <div className="map-viewport" onMouseDown={startMapMousePan} onMouseMove={moveMapMousePan} onMouseUp={endMapPan} onMouseLeave={endMapPan} onAuxClick={(e) => { if (e.button === 1) e.preventDefault(); }} onTouchStart={startMapTouchPan} onTouchMove={moveMapTouchPan} onTouchEnd={endMapPan} style={{ touchAction: "pan-y", cursor: panGesture.current.kind === "mouse" ? "grabbing" : "grab" }}>
            <div className="map-scroll" style={{ width: canvasWidth + 2, height: canvasHeight + 2, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
              <Stage width={canvasWidth} height={canvasHeight} scaleX={1} scaleY={1}>
                <Layer>
                  <Rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill="#111318" stroke="#3b3f49" strokeWidth={1} />
                  {Array.from({ length: Math.floor(widthM / gridM) + 1 }, (_, i) => (
                    <Line key={`vx-${i}`} points={[i * gridM * SCALE, 0, i * gridM * SCALE, canvasHeight]} stroke="#292d36" strokeWidth={0.7} listening={false} />
                  ))}
                  {Array.from({ length: Math.floor(lengthM / gridM) + 1 }, (_, i) => (
                    <Line key={`hy-${i}`} points={[0, i * gridM * SCALE, canvasWidth, i * gridM * SCALE]} stroke="#292d36" strokeWidth={0.7} listening={false} />
                  ))}
                  {objects.map((obj) => {
                    const isSelected = selectedId === obj.id;
                    const fill = OBJECT_COLORS[obj.type];
                    return (
                      <Group key={obj.id} x={obj.x * SCALE} y={obj.y * SCALE} rotation={obj.rotation}
                        draggable={canEditOperations}
                        onClick={() => setSelectedId(obj.id)}
                        onTap={() => setSelectedId(obj.id)}
                        onDragEnd={(e) => {
                          if (!canEditOperations) return;
                          const node = e.target;
                          const free = Boolean(e.evt.altKey);
                          moveObject(obj.id, node.x() / SCALE, node.y() / SCALE, free);
                          node.position({ x: obj.x * SCALE, y: obj.y * SCALE });
                        }}>
                        <Rect width={obj.width * SCALE} height={obj.length * SCALE} fill={fill} opacity={0.88}
                          stroke={isSelected ? "#ff424b" : "#858b98"} strokeWidth={isSelected ? 3 : 1.5} cornerRadius={5} />
                        <Text text={obj.label} width={obj.width * SCALE} height={obj.length * SCALE} align="center" verticalAlign="middle"
                          fontSize={Math.max(9, Math.min(13, obj.width * 7))} fill="#f2f3f5" listening={false} />
                      </Group>
                    );
                  })}
                </Layer>
              </Stage>
            </div>
          </div>
          <div className="map-footer"><span><kbd>Orta tuş</kbd> Kaydır</span><span><kbd>2 parmak</kbd> Kaydır</span><span><kbd>Tek parmak</kbd> Sayfayı kaydır</span><span>1 m = {SCALE}px</span></div>
        </section>

        <aside className="panel detail-panel">
          <div className="panel-heading"><div><span className="panel-kicker">03 / DETAY</span><h2>Seçili nesne</h2></div></div>
          {selected ? (
            <>
              <div className="selected-object">
                <span className={`object-icon large ${selected.type}-icon`}>{selected.type === "pallet" ? "▦" : selected.type === "rack" ? "▤" : "▱"}</span>
                <div><strong>{selected.label}</strong><span>{selected.type === "pallet" ? "Palet" : selected.type === "rack" ? "Raf" : selected.type === "cart" ? "Market arabası" : selected.type}</span></div>
              </div>
              {canEditOperations ? (
                <>
              <label className="field-label">Etiket<input value={selected.label} onChange={(e) => updateObject(selected.id, { label: e.target.value })} /></label>
              <div className="field-grid">
                <label className="field-label">X (m)<input type="number" step="0.1" value={selected.x} onChange={(e) => updateObject(selected.id, { x: Math.max(0, Math.min(widthM - selected.width, Number(e.target.value) || 0)) })} /></label>
                <label className="field-label">Y (m)<input type="number" step="0.1" value={selected.y} onChange={(e) => updateObject(selected.id, { y: Math.max(0, Math.min(lengthM - selected.length, Number(e.target.value) || 0)) })} /></label>
                <label className="field-label">Genişlik<input type="number" min="0.1" step="0.1" value={selected.width} onChange={(e) => updateObject(selected.id, { width: Math.max(0.1, Number(e.target.value) || 0.1) })} /></label>
                <label className="field-label">Uzunluk<input type="number" min="0.1" step="0.1" value={selected.length} onChange={(e) => updateObject(selected.id, { length: Math.max(0.1, Number(e.target.value) || 0.1) })} /></label>
              </div>
              <button className="secondary-button full-button" onClick={() => updateObject(selected.id, { rotation: (selected.rotation + 90) % 360 })}>↻ 90° döndür</button>
              <button
                type="button"
                className="secondary-button full-button"
                onClick={() => removeObject(selected.id)}
                style={{ marginTop: 8, color: "#b42318", borderColor: "#f0b8b4" }}
              >
                × Seçili nesneyi kaldır
              </button>
                </>
              ) : (
                <p className="helper-text">Bu hesapta nesne düzenleme yetkisi yok.</p>
              )}
              <div className="section-rule" />
              <div className="panel-heading compact"><div><span className="panel-kicker">ÜRÜN İÇERİĞİ</span><h2>Ürünler <span className="count-badge">{selected.products.length}</span></h2></div></div>
              <div className="product-list">
                {selected.products.length === 0 && <p className="empty-state">Bu konumda henüz ürün yok.</p>}
                {selected.products.map((p) => (
                  <div className="product-row" key={p.id}>
                    <div className="product-symbol">P</div><div className="product-copy"><strong>{p.name}</strong><span>{p.quantity === null ? "Miktar bilinmiyor" : `${p.quantity} ${p.unit}`}</span></div>
                    {canEditOperations && <button className="icon-button" title="Ürünü bu konumdan çıkar" onClick={() => removeProduct(p.id)}>×</button>}
                  </div>
                ))}
              </div>
              {canEditOperations && <div className="add-product-form">
                <label className="field-label">Ürün adı<input placeholder="Örn. Sakız" value={productName} onChange={(e) => setProductName(e.target.value)} /></label>
                <label className="field-label">Miktar (isteğe bağlı)<input type="number" min="0" step="1" disabled={unknownQuantity} placeholder="Örn. 12" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
                <label className="check-label"><input type="checkbox" checked={unknownQuantity} onChange={(e) => setUnknownQuantity(e.target.checked)} /> Miktarı bilmiyorum</label>
                <button className="primary-button full-button" onClick={addProduct}>+ Ürün ekle</button>
              </div>}
            </>
          ) : <p className="empty-state">Detayları görmek için haritadan bir palet, raf veya araba seç.</p>}
        </aside>
      </section>

      <section className="search-panel">
        <div className="search-intro"><span className="panel-kicker">04 / BUL</span><h2>Depoda ürün ara</h2><p>Ürün adını yaz; bulunan konumlar aşağıda listelensin.</p></div>
        <div className="search-content">
          <div className="search-input-wrap"><span>⌕</span><input aria-label="Ürün ara" placeholder="Ürün adı yaz (ör. kek, kraker)..." value={search} onChange={(e) => setSearch(e.target.value)} /><kbd>ARA</kbd></div>
          {search.trim() && <div className="search-results">
            {results.length === 0 ? <p className="empty-state">Eşleşen ürün bulunamadı.</p> : results.map((r) => (
              <button key={`${r.id}-${r.objectId}`} className="search-result" onClick={() => { setSelectedId(r.objectId); setNotice(`${r.name} bulundu: ${r.objectLabel}`); }}>
                <span className="result-marker">⌖</span><span className="result-main"><strong>{r.name}</strong><small>{r.objectLabel} · {r.quantity === null ? "Miktar bilinmiyor" : `${r.quantity} ${r.unit}`}</small></span><span className="result-action">Haritada göster →</span>
              </button>
            ))}
          </div>}
        </div>
      </section>
      {showAllProducts && (
        <div
          role="presentation"
          onClick={() => setShowAllProducts(false)}
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(15, 23, 42, 0.58)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="all-products-title"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(680px, 100%)", maxHeight: "min(80vh, 760px)",
              overflow: "auto", background: "#14161b", color: "#f2f3f5",
              borderRadius: 16, padding: 24, boxShadow: "0 24px 80px rgba(0,0,0,.25)"
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, marginBottom: 18 }}>
              <div>
                <span className="panel-kicker">DEPO ENVANTERİ</span>
                <h2 id="all-products-title" style={{ margin: "4px 0 0" }}>Tüm ürünler ({allProducts.length})</h2>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="Ürün listesini kapat"
                onClick={() => setShowAllProducts(false)}
                style={{ fontSize: 24 }}
              >×</button>
            </div>

            {allProducts.length === 0 ? (
              <p className="empty-state">Henüz depoya ürün eklenmemiş.</p>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {allProducts.map((product) => (
                  <button
                    type="button"
                    key={`${product.id}-${product.objectId}`}
                    className="search-result"
                    onClick={() => {
                      setSelectedId(product.objectId);
                      setShowAllProducts(false);
                      setNotice(`${product.name} bulundu: ${product.objectLabel}`);
                    }}
                    style={{
                      width: "100%", textAlign: "left", display: "flex",
                      alignItems: "center", gap: 12, padding: 14,
                      border: "1px solid #343944", borderRadius: 10,
                      background: "#1b1e25", cursor: "pointer"
                    }}
                  >
                    <span className="product-symbol">P</span>
                    <span className="result-main" style={{ flex: 1 }}>
                      <strong>{product.name}</strong>
                      <small>{product.objectLabel}</small>
                    </span>
                    <span style={{ display: "grid", justifyItems: "end", gap: 3 }}>
                      <strong style={{ color: "#15803d", fontSize: 13 }}>Depoda</strong>
                      <small style={{ color: "#aeb3bd" }}>
                        {product.quantity === null ? "Miktar bilinmiyor" : `${product.quantity} ${product.unit}`}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p style={{ color: "#aeb3bd", fontSize: 12, marginTop: 16 }}>
              Bir ürüne tıklayarak haritada bulunduğu palet, raf veya arabayı seçebilirsin.
            </p>
          </section>
        </div>
      )}

      <footer className="footer"><span>DESTOCK · DEPO YÖNETİMİ</span><span>{isCloudConfigured ? "Bulut kaydı ve anlık senkronizasyon" : "Yerel demo · bulut kaydı kapalı"}</span></footer>
    </main>
  );
}
