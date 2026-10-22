// ─── Creator index repair (#149) ────────────────────────────────────────────
//
// `repair_creator_index(creator, ids)` rebuilds the derived per-creator
// indexes (`CreatorResources`, `CreatorCount`, `CreatorListedCount`) from an
// admin-supplied authoritative id list, checked against canonical `Resource`
// ownership. These tests corrupt the derived keys directly, then check that a
// repair restores them, rejects bad input without partial writes, is admin-only,
// and is idempotent.

/// Overwrite `creator`'s derived index keys with drifted values, the way a bad
/// migration or a direct storage write could.
fn corrupt_creator_index(
    env: &Env,
    client: &VaultRegistryClient<'_>,
    creator: &Address,
    ids: &[&String],
    count: u32,
    listed: u32,
) {
    let mut list: Vec<String> = Vec::new(env);
    for id in ids {
        list.push_back((*id).clone());
    }
    env.as_contract(&client.address, || {
        env.storage()
            .persistent()
            .set(&DataKey::CreatorResources(creator.clone()), &list);
        env.storage()
            .instance()
            .set(&DataKey::CreatorCount(creator.clone()), &count);
        env.storage()
            .instance()
            .set(&DataKey::CreatorListedCount(creator.clone()), &listed);
    });
}

fn creator_ids(client: &VaultRegistryClient<'_>, creator: &Address) -> std::vec::Vec<String> {
    let page = client.list_by_creator(creator, &0u32, &20u32);
    (0..page.len()).map(|i| page.get(i).unwrap().id).collect()
}

fn ids_vec(env: &Env, ids: &[&String]) -> Vec<String> {
    let mut v = Vec::new(env);
    for id in ids {
        v.push_back((*id).clone());
    }
    v
}

#[test]
fn repair_creator_index_rebuilds_drifted_indexes_from_canonical_data() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepa1");
    let b = register_default(&env, &creator, &client, "crepa2");
    let c = register_default(&env, &creator, &client, "crepa3");
    client.delist(&b);
    let global_count = client.count();
    let global_listed = client.listed_count();

    // Drift: a duplicate, a missing id, and counters that match nothing.
    corrupt_creator_index(&env, &client, &creator, &[&a, &a], 7, 0);
    assert_eq!(client.creator_resource_count(&creator), 7);

    client.repair_creator_index(&creator, &ids_vec(&env, &[&c, &a, &b]));

    assert_eq!(
        creator_ids(&client, &creator),
        [c.clone(), a.clone(), b.clone()]
    );
    assert_eq!(client.creator_resource_count(&creator), 3);
    // Recomputed from each resource's state: `b` is delisted.
    assert_eq!(client.creator_listed_count(&creator), 2);
    // The id-cursor view reads the same repaired list.
    let page = client.list_by_creator_page(&creator, &IdCursor::Start, &20u32);
    assert_eq!(page.items.len(), 3);
    // Global indexes and canonical resources are untouched.
    assert_eq!(client.count(), global_count);
    assert_eq!(client.listed_count(), global_listed);
    assert_eq!(client.get(&a).creator, creator);
    assert!(!client.get(&b).listed);
}

#[test]
fn repair_creator_index_leaves_omitted_resources_readable() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepb1");
    let b = register_default(&env, &creator, &client, "crepb2");

    client.repair_creator_index(&creator, &ids_vec(&env, &[&b]));

    assert_eq!(creator_ids(&client, &creator), [b.clone()]);
    assert_eq!(client.creator_resource_count(&creator), 1);
    // Only the derived index changed; `a` is still a resource of `creator`.
    assert!(client.exists(&a));
    assert_eq!(client.get(&a).creator, creator);
}

#[test]
fn repair_creator_index_with_empty_list_clears_the_index() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepc1");
    let stranger = Address::generate(&env);
    // A creator who owns nothing but whose index points at someone else's id.
    corrupt_creator_index(&env, &client, &stranger, &[&a], 1, 1);

    client.repair_creator_index(&stranger, &Vec::new(&env));

    assert!(creator_ids(&client, &stranger).is_empty());
    assert_eq!(client.creator_resource_count(&stranger), 0);
    assert_eq!(client.creator_listed_count(&stranger), 0);
    // The real owner's index is untouched.
    assert_eq!(creator_ids(&client, &creator), [a.clone()]);
}

#[test]
fn repair_creator_index_rejects_unknown_id_without_partial_write() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepd1");
    corrupt_creator_index(&env, &client, &creator, &[&a, &a], 5, 0);

    let ghost = String::from_str(&env, "ghost");
    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a, &ghost]));

    assert_eq!(res, Err(Ok(Error::NotFound)));
    assert_eq!(creator_ids(&client, &creator), [a.clone(), a.clone()]);
    assert_eq!(client.creator_resource_count(&creator), 5);
    assert_eq!(client.creator_listed_count(&creator), 0);
}

#[test]
fn repair_creator_index_rejects_resource_owned_by_another_creator() {
    let (env, creator, _admin, client) = setup_with_admin();
    let mine = register_default(&env, &creator, &client, "crepe1");
    let other = Address::generate(&env);
    let theirs = register_default(&env, &other, &client, "crepe2");

    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&mine, &theirs]));

    assert_eq!(res, Err(Ok(Error::NotFound)));
    assert_eq!(creator_ids(&client, &creator), [mine.clone()]);
    assert_eq!(creator_ids(&client, &other), [theirs.clone()]);
}

#[test]
fn repair_creator_index_rejects_previous_owner_after_transfer() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepf1");
    let new_owner = Address::generate(&env);
    client.transfer_ownership(&a, &new_owner);

    // Canonical ownership moved, so `a` can only be repaired into the new owner.
    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a]));
    assert_eq!(res, Err(Ok(Error::NotFound)));

    client.repair_creator_index(&new_owner, &ids_vec(&env, &[&a]));
    assert_eq!(creator_ids(&client, &new_owner), [a.clone()]);
}

#[test]
fn repair_creator_index_rejects_tombstoned_resource() {
    let (env, creator, admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepg1");
    let b = register_default(&env, &creator, &client, "crepg2");
    client.tombstone_resource(&b, &admin);

    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a, &b]));

    assert_eq!(res, Err(Ok(Error::NotFound)));
    assert_eq!(creator_ids(&client, &creator), [a.clone()]);
}

#[test]
fn repair_creator_index_rejects_duplicates() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "creph1");
    let b = register_default(&env, &creator, &client, "creph2");

    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a, &b, &a]));

    assert_eq!(res, Err(Ok(Error::DuplicateInRepair)));
    assert_eq!(creator_ids(&client, &creator), [a.clone(), b.clone()]);
}

#[test]
fn repair_creator_index_before_admin_set_fails() {
    let (env, creator, client) = setup();
    let a = register_default(&env, &creator, &client, "crepi1");

    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a]));
    assert_eq!(res, Err(Ok(Error::AdminNotSet)));
}

#[test]
fn repair_creator_index_requires_admin_auth() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepj1");
    corrupt_creator_index(&env, &client, &creator, &[], 0, 0);

    // Without the admin's signature (e.g. the creator calling it) it fails.
    env.mock_auths(&[]);
    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a]));
    assert!(res.is_err());
    env.mock_all_auths();
    assert!(creator_ids(&client, &creator).is_empty());

    client.repair_creator_index(&creator, &ids_vec(&env, &[&a]));
    assert_eq!(creator_ids(&client, &creator), [a.clone()]);
}

#[test]
fn repair_creator_index_rejected_while_paused() {
    let (env, creator, admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepk1");
    client.set_paused(&admin, &true);

    let res = client.try_repair_creator_index(&creator, &ids_vec(&env, &[&a]));
    assert_eq!(res, Err(Ok(Error::ContractPaused)));
}

#[test]
fn repair_creator_index_emits_event_and_is_idempotent() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepl1");
    let b = register_default(&env, &creator, &client, "crepl2");
    client.delist(&a);
    corrupt_creator_index(&env, &client, &creator, &[&b], 4, 4);

    let list = ids_vec(&env, &[&a, &b]);
    client.repair_creator_index(&creator, &list);
    let first: CreatorIndexRepair =
        find_event(&env, &client.address, "recrtidx").expect("recrtidx event");
    assert_eq!(
        first,
        CreatorIndexRepair {
            creator: creator.clone(),
            old_count: 4,
            new_count: 2,
            listed_count: 1,
        }
    );

    // Running the same repair again rewrites the same state.
    client.repair_creator_index(&creator, &list);
    let second: CreatorIndexRepair =
        find_event(&env, &client.address, "recrtidx").expect("recrtidx event");
    assert_eq!(second.old_count, 2);
    assert_eq!(second.new_count, 2);
    assert_eq!(second.listed_count, 1);
    assert_eq!(creator_ids(&client, &creator), [a.clone(), b.clone()]);
    assert_eq!(client.creator_resource_count(&creator), 2);
    assert_eq!(client.creator_listed_count(&creator), 1);
}

#[test]
fn repaired_creator_index_keeps_working_with_later_mutations() {
    let (env, creator, _admin, client) = setup_with_admin();
    let a = register_default(&env, &creator, &client, "crepm1");
    let b = register_default(&env, &creator, &client, "crepm2");
    corrupt_creator_index(&env, &client, &creator, &[], 0, 0);
    client.repair_creator_index(&creator, &ids_vec(&env, &[&a, &b]));

    // Later writes maintain the repaired indexes incrementally as usual.
    let c = register_default(&env, &creator, &client, "crepm3");
    let new_owner = Address::generate(&env);
    client.transfer_ownership(&a, &new_owner);
    client.delist(&b);

    assert_eq!(creator_ids(&client, &creator), [b.clone(), c.clone()]);
    assert_eq!(client.creator_resource_count(&creator), 2);
    assert_eq!(client.creator_listed_count(&creator), 1);
    assert_eq!(creator_ids(&client, &new_owner), [a.clone()]);
}
