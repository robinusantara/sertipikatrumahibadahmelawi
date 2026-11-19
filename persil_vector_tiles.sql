-- Migrasi yang sudah diterapkan ke proyek Supabase jflqadlasztjrhxpivot (nama: persil_vector_tiles)
create extension if not exists postgis with schema extensions;

alter table public.layers add column if not exists kind text not null default 'geojson';
alter table public.layers add column if not exists bounds jsonb;

create table if not exists public.persil (
  id bigint generated always as identity primary key,
  layer_id text not null references public.layers(id) on delete cascade,
  nib text, tipe_hak text, kelurahan text, kecamatan text,
  geom extensions.geometry(MultiPolygon, 3857) not null
);
create index if not exists persil_geom_gix on public.persil using gist (geom);
create index if not exists persil_layer_idx on public.persil (layer_id);

alter table public.persil enable row level security;
drop policy if exists "baca publik" on public.persil;
drop policy if exists "admin tulis" on public.persil;
create policy "baca publik" on public.persil for select to anon, authenticated using (true);
create policy "admin tulis" on public.persil for all to authenticated using (true) with check (true);

create or replace function public.prop_pick(p jsonb, pat text)
returns text language sql immutable set search_path = public, extensions as $$
  select nullif(btrim(p ->> k), '')
  from jsonb_object_keys(case when jsonb_typeof(p) = 'object' then p else '{}'::jsonb end) k
  where regexp_replace(upper(k), '[^A-Z0-9]', '', 'g') ~ pat
  order by length(k), k limit 1
$$;

create or replace function public.persil_import(p_layer text, p_features jsonb)
returns integer language plpgsql set search_path = public, extensions as $$
declare n integer;
begin
  insert into public.persil (layer_id, nib, tipe_hak, kelurahan, kecamatan, geom)
  select p_layer,
         public.prop_pick(f -> 'properties', '^(NO)?NIB$|^NIB'),
         public.prop_pick(f -> 'properties', '^(TIPEHAK|JENISHAK)'),
         public.prop_pick(f -> 'properties', '^(KELURAHAN|KEL|NAMAKEL|NMKEL|DESA|NAMADESA|NMDESA|WADMKD|DESAKEL|KELDESA)$'),
         public.prop_pick(f -> 'properties', '^(KECAMATAN|KEC|NAMAKEC|NMKEC|WADMKC)$'),
         g.geom
  from jsonb_array_elements(p_features) f
  cross join lateral (
    select ST_Transform(ST_SetSRID(ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_GeomFromGeoJSON(f -> 'geometry')), 3)), 4326), 3857) as geom
  ) g
  where f -> 'geometry' is not null and jsonb_typeof(f -> 'geometry') = 'object'
    and g.geom is not null and not ST_IsEmpty(g.geom);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.persil_finalize(p_layer text)
returns jsonb language plpgsql set search_path = public, extensions as $$
declare c bigint; b extensions.box2d; bnds jsonb;
begin
  select count(*), ST_Extent(ST_Transform(geom, 4326)) into c, b from public.persil where layer_id = p_layer;
  bnds := case when b is null then null else jsonb_build_array(ST_XMin(b), ST_YMin(b), ST_XMax(b), ST_YMax(b)) end;
  update public.layers set count = c, bounds = bnds, kind = 'vector' where id = p_layer;
  return jsonb_build_object('count', c, 'bounds', bnds);
end $$;

create or replace function public.persil_tile(z integer, x integer, y integer, p_layer text)
returns bytea language sql stable set search_path = public, extensions as $$
  select coalesce(ST_AsMVT(q, 'persil', 4096, 'geom'), ''::bytea)
  from (
    select s.nib, s.tipe_hak, s.kelurahan, s.kecamatan,
           ST_AsMVTGeom(s.geom, ST_TileEnvelope(z, x, y), 4096, 64, true) as geom
    from public.persil s
    where z >= 13 and s.layer_id = p_layer
      and s.geom && ST_TileEnvelope(z, x, y, margin => 64.0 / 4096)
  ) q where q.geom is not null
$$;

create or replace function public.persil_cek(p_layers text[], p_pts jsonb)
returns table (i integer, layer_id text, nib text, tipe_hak text, kelurahan text, kecamatan text)
language sql stable set search_path = public, extensions as $$
  select (pt ->> 'i')::integer, s.layer_id, s.nib, s.tipe_hak, s.kelurahan, s.kecamatan
  from jsonb_array_elements(p_pts) pt
  cross join lateral (select ST_Transform(ST_SetSRID(ST_MakePoint((pt ->> 'lng')::float8, (pt ->> 'lat')::float8), 4326), 3857) as g) p
  join public.persil s on s.layer_id = any (p_layers) and s.geom && p.g and ST_Intersects(s.geom, p.g)
$$;

revoke execute on function public.persil_import(text, jsonb) from public, anon;
revoke execute on function public.persil_finalize(text) from public, anon;
grant execute on function public.persil_import(text, jsonb) to authenticated;
grant execute on function public.persil_finalize(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Tile MVT untuk PostgREST >= 12 (sudah ada di proyek jflqadlasztjrhxpivot; idempotent).
-- Accept: application/octet-stream untuk hasil bytea sudah TIDAK didukung (HTTP 406).
-- Klien memanggil rpc/persil_mvt dengan "Accept: application/vnd.mapbox-vector-tile".
-- ---------------------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'public' and t.typname = 'application/vnd.mapbox-vector-tile') then
    create domain public."application/vnd.mapbox-vector-tile" as bytea;
  end if;
end $$;

create or replace function public.persil_mvt(z integer, x integer, y integer, p_layer text)
returns public."application/vnd.mapbox-vector-tile"
language sql stable parallel safe set search_path = public, extensions as $$
  select coalesce(ST_AsMVT(q, 'persil', 4096, 'geom'), ''::bytea)::public."application/vnd.mapbox-vector-tile"
  from (
    select s.nib, s.tipe_hak, s.kelurahan, s.kecamatan,
           ST_AsMVTGeom(s.geom, ST_TileEnvelope(z, x, y), 4096, 64, true) as geom
    from public.persil s
    where z >= 13 and s.layer_id = p_layer
      and s.geom && ST_TileEnvelope(z, x, y, margin => 64.0 / 4096)
  ) q where q.geom is not null
$$;
grant execute on function public.persil_mvt(integer, integer, integer, text) to anon, authenticated;
notify pgrst, 'reload schema';
