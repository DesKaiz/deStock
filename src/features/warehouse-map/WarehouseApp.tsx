"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  const [user, setUser] = useState<{ id: string; email?: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(Boolean(isCloudConfigured));
  const [authBusy, setAuthBusy] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [organizationId, setOrganizationId] = useState<string | null>(null);
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

  // Oturum bilgisini al ve giriş/çıkış değişikliklerini dinle.
  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data, error }) => {
      if (!alive) return;
      if (error) setDataError(error.message);
      setUser(data.session?.user ? { id: data.session.user.id, email: data.session.user.email } : null);
      setAuthLoading(false);
    });
    const { data: authListener } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setUser(session?.user ? { id: session.user.id, email: session.user.email } : null);
      setAuthLoading(false);
    });
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
        const { data: membership, error: membershipError } = await supabase!
          .from("memberships")
          .select("organization_id,role")
          .eq("user_id", user!.id)
          .limit(1)
          .maybeSingle();
        if (membershipError) throw membershipError;

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
        const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
        if (error) throw error;
        if (!data.session) {
          setNotice("Hesap oluşturuldu. Supabase e-posta doğrulaması istiyorsa gelen kutunu kontrol et, ardından giriş yap.");
        } else {
          setNotice("Hesap oluşturuldu. Depo hazırlanıyor.");
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        setNotice("Giriş başarılı. Depo verileri yükleniyor.");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Kimlik doğrulama başarısız.";
      setDataError(message);
      setNotice(message);
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    const { error } = await supabase.auth.signOut();
    if (error) setNotice(`Çıkış yapılamadı: ${error.message}`);
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

  const canvasWidth = Math.max(300, widthM * SCALE);
  const canvasHeight = Math.max(240, lengthM * SCALE);

  if (isCloudConfigured && authLoading) {
    return <main className="app-shell"><section className="panel" style={{ maxWidth: 520, margin: "12vh auto", padding: 32 }}><h1>DepoMap</h1><p>Oturum kontrol ediliyor...</p></section></main>;
  }

  if (isCloudConfigured && !user) {
    return (
      <main className="app-shell">
        <section className="panel" style={{ maxWidth: 480, margin: "8vh auto", padding: 32 }}>
          <div className="brand-mark" style={{ marginBottom: 16 }}>D</div>
          <p className="eyebrow">DEPOMAP / BULUT HESABI</p>
          <h1 style={{ marginBottom: 8 }}>{authMode === "signin" ? "Hesabına giriş yap" : "Yeni hesap oluştur"}</h1>
          <p className="subtitle">Depo bilgilerin hesabına kaydedilir ve yetkili ekip üyeleriyle senkronize edilir.</p>
          <form onSubmit={handleAuthSubmit} style={{ display: "grid", gap: 14, marginTop: 24 }}>
            <label className="field-label">E-posta<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="field-label">Şifre<input type="password" autoComplete={authMode === "signin" ? "current-password" : "new-password"} minLength={6} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
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

  if (isCloudConfigured && user && dataLoading) {
    return <main className="app-shell"><section className="panel" style={{ maxWidth: 520, margin: "12vh auto", padding: 32 }}><h1>DepoMap</h1><p>Depo ve ürün bilgileri buluttan yükleniyor...</p></section></main>;
  }

  if (isCloudConfigured && user && dataError) {
    return (
      <main className="app-shell">
        <section className="panel" style={{ maxWidth: 560, margin: "10vh auto", padding: 32 }}>
          <h1>Bulut bağlantısı kurulamadı</h1>
          <p role="alert" style={{ color: "#b42318", marginTop: 12 }}>{dataError}</p>
          <p className="helper-text" style={{ marginTop: 12 }}>Supabase SQL kurulumunun uygulandığını ve .env.local değişkenlerini kontrol et. Bu ekranda değişiklik yaparsan kaydedilmeyebilir.</p>
          <button className="primary-button full-button" style={{ marginTop: 18 }} onClick={() => window.location.reload()}>Yeniden dene</button>
          <button className="secondary-button full-button" style={{ marginTop: 10 }} onClick={signOut}>Çıkış yap</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">D</div>
        <div className="brand-copy"><strong>DepoMap</strong><span>Depo konum yönetimi</span></div>
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
          <div className="metric-grid">
            <div className="metric-card"><span>Alan</span><strong>{(widthM * lengthM).toLocaleString("tr-TR")} m²</strong></div>
            <div className="metric-card"><span>Nesne</span><strong>{objects.length}</strong></div>
          </div>
          <div className="section-rule" />
          <div className="panel-heading compact"><div><span className="panel-kicker">02 / EKLE</span><h2>Haritaya nesne</h2></div></div>
          <div className="add-grid">
            <button onClick={() => addObject("pallet")} className="add-button"><span className="object-icon pallet-icon">▦</span><span>Palet</span><b>+</b></button>
            <button onClick={() => addObject("rack")} className="add-button"><span className="object-icon rack-icon">▤</span><span>Raf</span><b>+</b></button>
            <button onClick={() => addObject("cart")} className="add-button"><span className="object-icon cart-icon">▱</span><span>Araba</span><b>+</b></button>
          </div>
          <p className="helper-text">Nesneleri harita üzerinde sürükle. Alt tuşunu basılı tutarak ızgara dışında konumlandırabilirsin.</p>
        </aside>

        <section className="map-panel">
          <div className="map-header">
            <div><span className="panel-kicker">CANLI ÖNİZLEME</span><h2>{warehouseName || "Yeni depo"}</h2><p>{widthM} m × {lengthM} m · {gridM} m ızgara</p></div>
            <div className="map-legend"><span><i className="legend-dot pallet-dot" />Palet</span><span><i className="legend-dot rack-dot" />Raf</span><span><i className="legend-dot cart-dot" />Araba</span></div>
          </div>
          <div className="map-viewport">
            <div className="map-scroll" style={{ width: canvasWidth + 2, height: canvasHeight + 2 }}>
              <Stage width={canvasWidth} height={canvasHeight} scaleX={1} scaleY={1}>
                <Layer>
                  <Rect x={0} y={0} width={canvasWidth} height={canvasHeight} fill="#f8fafc" stroke="#cbd5e1" strokeWidth={1} />
                  {Array.from({ length: Math.floor(widthM / gridM) + 1 }, (_, i) => (
                    <Line key={`vx-${i}`} points={[i * gridM * SCALE, 0, i * gridM * SCALE, canvasHeight]} stroke="#e3e8ef" strokeWidth={0.7} listening={false} />
                  ))}
                  {Array.from({ length: Math.floor(lengthM / gridM) + 1 }, (_, i) => (
                    <Line key={`hy-${i}`} points={[0, i * gridM * SCALE, canvasWidth, i * gridM * SCALE]} stroke="#e3e8ef" strokeWidth={0.7} listening={false} />
                  ))}
                  {objects.map((obj) => {
                    const isSelected = selectedId === obj.id;
                    const fill = OBJECT_COLORS[obj.type];
                    return (
                      <Group key={obj.id} x={obj.x * SCALE} y={obj.y * SCALE} rotation={obj.rotation}
                        draggable
                        onClick={() => setSelectedId(obj.id)}
                        onTap={() => setSelectedId(obj.id)}
                        onDragEnd={(e) => {
                          const node = e.target;
                          const free = Boolean(e.evt.altKey);
                          moveObject(obj.id, node.x() / SCALE, node.y() / SCALE, free);
                          node.position({ x: obj.x * SCALE, y: obj.y * SCALE });
                        }}>
                        <Rect width={obj.width * SCALE} height={obj.length * SCALE} fill={fill} opacity={0.88}
                          stroke={isSelected ? "#111827" : "#ffffff"} strokeWidth={isSelected ? 3 : 1.5} cornerRadius={5} />
                        <Text text={obj.label} width={obj.width * SCALE} height={obj.length * SCALE} align="center" verticalAlign="middle"
                          fontSize={Math.max(9, Math.min(13, obj.width * 7))} fill="#17202c" listening={false} />
                      </Group>
                    );
                  })}
                </Layer>
              </Stage>
            </div>
          </div>
          <div className="map-footer"><span><kbd>Drag</kbd> Taşı</span><span><kbd>Click</kbd> Seç</span><span>Ölçek: 1 m = {SCALE}px</span></div>
        </section>

        <aside className="panel detail-panel">
          <div className="panel-heading"><div><span className="panel-kicker">03 / DETAY</span><h2>Seçili nesne</h2></div></div>
          {selected ? (
            <>
              <div className="selected-object">
                <span className={`object-icon large ${selected.type}-icon`}>{selected.type === "pallet" ? "▦" : selected.type === "rack" ? "▤" : "▱"}</span>
                <div><strong>{selected.label}</strong><span>{selected.type === "pallet" ? "Palet" : selected.type === "rack" ? "Raf" : selected.type === "cart" ? "Market arabası" : selected.type}</span></div>
              </div>
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
              <div className="section-rule" />
              <div className="panel-heading compact"><div><span className="panel-kicker">ÜRÜN İÇERİĞİ</span><h2>Ürünler <span className="count-badge">{selected.products.length}</span></h2></div></div>
              <div className="product-list">
                {selected.products.length === 0 && <p className="empty-state">Bu konumda henüz ürün yok.</p>}
                {selected.products.map((p) => (
                  <div className="product-row" key={p.id}>
                    <div className="product-symbol">P</div><div className="product-copy"><strong>{p.name}</strong><span>{p.quantity === null ? "Miktar bilinmiyor" : `${p.quantity} ${p.unit}`}</span></div>
                    <button className="icon-button" title="Ürünü bu konumdan çıkar" onClick={() => removeProduct(p.id)}>×</button>
                  </div>
                ))}
              </div>
              <div className="add-product-form">
                <label className="field-label">Ürün adı<input placeholder="Örn. Sakız" value={productName} onChange={(e) => setProductName(e.target.value)} /></label>
                <label className="field-label">Miktar (isteğe bağlı)<input type="number" min="0" step="1" disabled={unknownQuantity} placeholder="Örn. 12" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
                <label className="check-label"><input type="checkbox" checked={unknownQuantity} onChange={(e) => setUnknownQuantity(e.target.checked)} /> Miktarı bilmiyorum</label>
                <button className="primary-button full-button" onClick={addProduct}>+ Ürün ekle</button>
              </div>
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
              overflow: "auto", background: "#fff", color: "#17202c",
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
                      border: "1px solid #e5e7eb", borderRadius: 10,
                      background: "#fff", cursor: "pointer"
                    }}
                  >
                    <span className="product-symbol">P</span>
                    <span className="result-main" style={{ flex: 1 }}>
                      <strong>{product.name}</strong>
                      <small>{product.objectLabel}</small>
                    </span>
                    <span style={{ display: "grid", justifyItems: "end", gap: 3 }}>
                      <strong style={{ color: "#15803d", fontSize: 13 }}>Depoda</strong>
                      <small style={{ color: "#64748b" }}>
                        {product.quantity === null ? "Miktar bilinmiyor" : `${product.quantity} ${product.unit}`}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <p style={{ color: "#64748b", fontSize: 12, marginTop: 16 }}>
              Bir ürüne tıklayarak haritada bulunduğu palet, raf veya arabayı seçebilirsin.
            </p>
          </section>
        </div>
      )}

      <footer className="footer"><span>DEPOMAP · ERKEN GELİŞTİRME SÜRÜMÜ</span><span>{isCloudConfigured ? "Bulut kaydı ve anlık senkronizasyon" : "Yerel demo · bulut kaydı kapalı"}</span></footer>
    </main>
  );
}
